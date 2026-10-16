'use strict';

/**
 * ============================================================================
 *  HTML → APK Converter — Backend service (Express + Apache Cordova pipeline)
 * ============================================================================
 *
 *  Receives a zipped static website (HTML/CSS/JS), wraps it in a fresh Apache
 *  Cordova shell, compiles a debug-signed Android APK on the server, and
 *  streams the binary back to the browser.
 *
 *  Endpoint:
 *    POST /api/build-apk   (multipart/form-data)
 *      - appName     (text)  : human readable app name
 *      - packageId   (text)  : reverse-domain id, e.g. com.example.app
 *      - webAssets   (file)  : .zip archive containing index.html at root
 *
 *  Pipeline (per request, fully isolated):
 *    1. multer stores the uploaded .zip in the OS temp directory
 *    2. the archive is validated in-memory (integrity, paths, index.html)
 *    3. a unique, timestamped workspace is created in the OS temp directory
 *    4. `npx cordova create` scaffolds a fresh Cordova project
 *    5. the default www/ directory is emptied and the user's zip is extracted
 *    6. `npx cordova platform add android`
 *    7. `npx cordova build android`  →  app-debug.apk
 *    8. the APK is streamed back with res.download()
 *    9. a `finally` block deletes the workspace + uploaded zip — always
 *
 *  Environment variables (all optional):
 *    PORT               listen port                     (default 3000)
 *    HOST               bind address                    (default 0.0.0.0)
 *    MAX_UPLOAD_MB      max .zip upload size            (default 50)
 *    MAX_UNPACKED_MB    max size after extraction       (default 300)
 *    BUILD_TIMEOUT_MIN  hard timeout per cordova build  (default 30)
 *
 *  Host requirements (Android SDK / JDK 17) are documented in README.md.
 *  Target platform: Linux (Ubuntu/Debian or WSL2). On Windows run inside WSL2.
 * ============================================================================
 */

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fse = require('fs-extra');
const AdmZip = require('adm-zip');

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const MAX_UNPACKED_MB = Number(process.env.MAX_UNPACKED_MB) || 300;
const BUILD_TIMEOUT_MIN = Number(process.env.BUILD_TIMEOUT_MIN) || 30;

/** Where multer temporarily parks uploaded archives. */
const UPLOAD_DIR = path.join(os.tmpdir(), 'html-to-apk-uploads');

/** Reverse-domain package id, e.g. com.example.app (Java package rules). */
const PACKAGE_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Java reserved words that are illegal as a package-id segment. */
const JAVA_RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);

/** How much command output is kept for error reporting. */
const LOG_TAIL_BYTES = 8000;

/**
 * ApiError — an error that is safe to show to the end user.
 * `status` selects the HTTP status code; `log` optionally carries the raw
 * command output tail (shown in the UI as a collapsible "server log").
 */
class ApiError extends Error {
  constructor(message, { status = 400, log = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.log = log;
  }
}

/* -------------------------------------------------------------------------- */
/*  Express app                                                               */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.use(cors());

/* -------------------------------------------------------------------------- */
/*  Multer — temporary storage for the uploaded .zip                          */
/* -------------------------------------------------------------------------- */

fse.ensureDirSync(UPLOAD_DIR);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    // Random, collision-free filename; keep the .zip extension.
    filename: (req, file, cb) =>
      cb(null, `upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.zip`),
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    // Extension is the source of truth; some browsers send odd MIME types.
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new ApiError('Only .zip files are accepted. Please zip your web assets and try again.'));
    }
    const allowed = new Set([
      'application/zip',
      'application/x-zip-compressed',
      'application/x-zip',
      'multipart/x-zip',
      'application/octet-stream',
    ]);
    if (!allowed.has(file.mimetype)) {
      return cb(new ApiError('The uploaded file does not look like a ZIP archive.'));
    }
    cb(null, true);
  },
});

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Strip characters that would break config.xml / strings.xml / the shell. */
function sanitizeAppName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError('App Name is required.');
  }
  const cleaned = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '') // control chars + filesystem unsafe
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
  if (!cleaned) {
    throw new ApiError('App Name must contain at least one valid character.');
  }
  return cleaned;
}

/** Validate the Cordova / Java package identifier. */
function validatePackageId(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError('Package ID is required (e.g. com.example.app).');
  }
  const id = raw.trim();
  if (!PACKAGE_ID_RE.test(id)) {
    throw new ApiError(
      'Invalid Package ID. Use reverse-domain format with at least two segments, ' +
      'each starting with a letter — e.g. com.example.app'
    );
  }
  for (const segment of id.split('.')) {
    if (JAVA_RESERVED.has(segment.toLowerCase())) {
      throw new ApiError(`Invalid Package ID: "${segment}" is a reserved Java keyword.`);
    }
  }
  return id;
}

/** Filesystem-safe, lowercase name for the downloaded .apk file. */
function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'app';
}

/* -------------------------------------------------------------------------- */
/*  Shell command runner                                                      */
/* -------------------------------------------------------------------------- */

/** All currently running child processes (used for abort + shutdown). */
const activeChildren = new Set();

/**
 * Run a command without a shell (no injection risk), capture its output,
 * enforce a hard timeout, and stream progress into the server console with a
 * per-build tag so concurrent builds remain readable.
 *
 * @param {string}   command   executable, e.g. "npx"
 * @param {string[]} args      argument array, e.g. ["cordova", "create", ...]
 * @param {object}   opts      { cwd, timeoutMs, tag }
 * @param {Function} [onProcess] receives the spawned child (for abort tracking)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runCommand(command, args, opts = {}, onProcess = null) {
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = opts.timeoutMs || 15 * 60 * 1000;
  const tag = opts.tag || command;

  return new Promise((resolve, reject) => {
    console.log(`\n▶ [${tag}] ${command} ${args.join(' ')}`);

    // CI=1 tells Cordova to never prompt (e.g. telemetry opt-in) — a prompt
    // would hang the build forever in a non-interactive environment.
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, CI: '1' },
    });
    activeChildren.add(child);
    if (onProcess) onProcess(child);

    let stdoutTail = '';
    let stderrTail = '';

    // Capture a bounded tail of each stream for error reporting, and echo the
    // live output into the server console tagged with the build step so that
    // concurrent builds remain distinguishable in the logs.
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutTail = (stdoutTail + text).slice(-LOG_TAIL_BYTES);
      process.stdout.write(text.replace(/^/gm, `  [${tag}] `));
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-LOG_TAIL_BYTES);
      process.stderr.write(text.replace(/^/gm, `  [${tag}] `));
    });

    const timer = setTimeout(() => {
      const log = formatLog(stdoutTail, stderrTail);
      try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
      reject(new ApiError(
        `Build step "${tag}" timed out after ${Math.round(timeoutMs / 60000)} minute(s) and was aborted.`,
        { status: 500, log }
      ));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      reject(new ApiError(
        `Failed to execute "${command}". Is it installed and available on the PATH? (${err.message})`,
        { status: 500, log: formatLog(stdoutTail, stderrTail) }
      ));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      const log = formatLog(stdoutTail, stderrTail);
      if (code === 0) {
        resolve({ stdout: stdoutTail, stderr: stderrTail });
      } else {
        reject(new ApiError(
          `Build step "${tag}" failed with exit code ${code === null ? signal : code}.`,
          { status: 500, log }
        ));
      }
    });
  });
}

/** Compose a compact, labeled log tail for error reporting. */
function formatLog(stdoutTail, stderrTail) {
  return [
    '--- stdout (last lines) ---',
    stdoutTail.trim() || '(no output)',
    '--- stderr (last lines) ---',
    stderrTail.trim() || '(no output)',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  ZIP inspection — security & error boundaries                              */
/* -------------------------------------------------------------------------- */

/** Junk entries that macOS archivers sneak into otherwise clean archives. */
const ZIP_JUNK_RE = /^(__MACOSX\/|\.DS_Store$)/i;

/**
 * Validate the uploaded archive BEFORE any expensive Cordova work:
 *   - readable / well-formed zip
 *   - not empty
 *   - no path traversal ("../", absolute paths, null bytes)  [zip-slip]
 *   - unpacked size within MAX_UNPACKED_MB                    [zip bomb]
 *   - contains index.html at the root, or inside a single top-level folder
 *
 * @returns {{rootPrefix: string|null, fileCount: number, totalUncompressed: number}}
 */
function inspectZip(zipPath) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    throw new ApiError('The uploaded file is not a valid ZIP archive (it may be corrupted or misnamed).');
  }

  let entries;
  try {
    entries = zip.getEntries();
  } catch (err) {
    throw new ApiError('The ZIP archive appears to be corrupted and could not be read.');
  }

  const files = entries.filter(
    (e) => !e.isDirectory && !ZIP_JUNK_RE.test(e.entryName)
  );
  if (files.length === 0) {
    throw new ApiError('The ZIP archive does not contain any files.');
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    if (name.includes('\u0000')) {
      throw new ApiError('The ZIP archive contains an entry with an unsafe (null-byte) filename.');
    }
    // Normalize, then reject anything that escapes the extraction root.
    // After posix.normalize, a surviving ".." can only appear as a leading
    // segment (e.g. "../evil.txt" or "../../x") — catch those explicitly.
    const normalized = path.posix.normalize(name);
    if (
      !normalized ||
      normalized === '.' ||
      normalized.startsWith('..') ||
      normalized.split('/').includes('..') ||
      path.posix.isAbsolute(name)
    ) {
      throw new ApiError(
        `The ZIP archive contains an unsafe path ("${name}"). Path traversal is not allowed.`
      );
    }
    totalUncompressed += Number(entry.header.size) || 0;
  }

  if (totalUncompressed > MAX_UNPACKED_MB * 1024 * 1024) {
    throw new ApiError(
      `The ZIP archive unpacks to ${Math.round(totalUncompressed / 1024 / 1024)} MB, ` +
      `which exceeds the ${MAX_UNPACKED_MB} MB server limit.`
    );
  }

  const isRootIndex = (e) =>
    path.posix.normalize(e.entryName).replace(/^\.\//, '') === 'index.html';

  if (files.some(isRootIndex)) {
    return { rootPrefix: null, fileCount: files.length, totalUncompressed };
  }

  // Common user mistake: zipping the FOLDER instead of its CONTENTS
  // (e.g. my-site/index.html). If everything lives inside exactly one
  // top-level folder that holds index.html, we will flatten it after
  // extraction — otherwise fail with a helpful message.
  const topDirs = new Set(files.map((e) => e.entryName.split('/')[0]));
  if (topDirs.size === 1) {
    const only = [...topDirs][0];
    if (files.some((e) => e.entryName === `${only}/index.html`)) {
      return { rootPrefix: `${only}/`, fileCount: files.length, totalUncompressed };
    }
  }

  throw new ApiError(
    'No index.html found. The ZIP must contain an index.html at its root ' +
    '(or inside a single top-level folder).'
  );
}

/**
 * Extract the user's zip into the Cordova www directory (spec: adm-zip),
 * flattening a single top-level folder when needed, and verify the result.
 */
async function extractWebAssets(zipPath, wwwPath, rootPrefix) {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(wwwPath, true);

  if (rootPrefix) {
    const nested = path.join(wwwPath, rootPrefix.replace(/\/$/, ''));
    const children = await fse.readdir(nested);
    for (const child of children) {
      await fse.move(path.join(nested, child), path.join(wwwPath, child), { overwrite: true });
    }
    await fse.remove(nested);
  }

  if (!fse.existsSync(path.join(wwwPath, 'index.html'))) {
    throw new ApiError('index.html is missing after extraction — the archive layout is unexpected.');
  }
}

/* -------------------------------------------------------------------------- */
/*  APK discovery                                                             */
/* -------------------------------------------------------------------------- */

/** Cordova's known debug APK output locations, most specific first. */
const APK_CANDIDATES = [
  'platforms/android/app/build/outputs/apk/debug/app-debug.apk',
  'platforms/android/build/outputs/apk/debug/app-debug.apk',
];

/**
 * Locate the compiled APK inside the Cordova project.
 * Falls back to a recursive search of the android output tree.
 */
async function findApk(projectPath) {
  for (const rel of APK_CANDIDATES) {
    const candidate = path.join(projectPath, rel);
    if (await fse.pathExists(candidate)) return candidate;
  }

  const outputsRoot = path.join(projectPath, 'platforms', 'android');
  const found = [];

  async function walk(dir, depth) {
    if (depth > 8 || found.length) return;
    let items;
    try { items = await fse.readdir(dir); } catch (_) { return; }
    for (const item of items) {
      const full = path.join(dir, item);
      let stat;
      try { stat = await fse.stat(full); } catch (_) { continue; }
      if (stat.isDirectory()) await walk(full, depth + 1);
      else if (item.endsWith('.apk')) found.push(full);
    }
  }
  await walk(outputsRoot, 0);

  if (found.length) return found[0];
  throw new ApiError(
    'The build finished, but no .apk file was found in the Cordova output directories.',
    { status: 500 }
  );
}

/* -------------------------------------------------------------------------- */
/*  Build endpoint                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Full pipeline for one build request. Every error path funnels through the
 * single catch block; the finally block guarantees strict cleanup.
 */
async function handleBuildRequest(req, res) {
  const uploadedFile = req.file;
  let workspace = null;
  let activeChild = null;
  const startedAt = Date.now();

  // If the browser disconnects (tab closed / aborted), kill the running
  // cordova command so the machine is not wasted on an orphaned build.
  req.on('close', () => {
    if (activeChild) {
      try { activeChild.kill('SIGKILL'); } catch (_) { /* already dead */ }
    }
  });

  // Every spawned cordova command is registered with this request, so an
  // aborted request (browser closed) kills the running build immediately.
  const run = (cmd, args, opts = {}) =>
    runCommand(cmd, args, opts, (child) => { activeChild = child; });

  try {
    /* -- 1. Validate form fields ------------------------------------------ */
    const appName = sanitizeAppName(req.body.appName);
    const appId = validatePackageId(req.body.packageId);
    if (!uploadedFile) {
      throw new ApiError('No web assets were uploaded. Please attach a .zip file.');
    }

    /* -- 2. Fast ZIP validation (before any expensive Cordova work) ------- */
    const zipInfo = inspectZip(uploadedFile.path);

    /* -- 3. Unique, timestamped workspace per request --------------------- */
    workspace = path.join(
      os.tmpdir(),
      `cordova-build-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    );
    await fse.ensureDir(workspace);
    const projectPath = path.join(workspace, 'project');
    const wwwPath = path.join(projectPath, 'www');

    console.log(
      `\n=== New build: "${appName}" <${appId}> | ${zipInfo.fileCount} files, ` +
      `${Math.round(zipInfo.totalUncompressed / 1024)} KB unpacked | ${workspace} ===`
    );

    /* -- 4. Scaffold a fresh Cordova project ------------------------------ */
    await run('npx', ['cordova', 'create', 'project', appId, appName, '--no-telemetry'], {
      cwd: workspace,
      timeoutMs: 10 * 60 * 1000,
      tag: 'cordova create',
    });

    /* -- 5. Empty the default www/ and extract the user's assets ---------- */
    await fse.emptyDir(wwwPath);
    await extractWebAssets(uploadedFile.path, wwwPath, zipInfo.rootPrefix);

    /* -- 6. Add the Android platform --------------------------------------- */
    await run('npx', ['cordova', 'platform', 'add', 'android', '--no-telemetry'], {
      cwd: projectPath,
      timeoutMs: 15 * 60 * 1000,
      tag: 'cordova platform add',
    });

    /* -- 7. Compile the debug APK ------------------------------------------ */
    await run('npx', ['cordova', 'build', 'android', '--no-telemetry'], {
      cwd: projectPath,
      timeoutMs: BUILD_TIMEOUT_MIN * 60 * 1000,
      tag: 'cordova build',
    });

    /* -- 8. Locate and stream the APK back --------------------------------- */
    const apkPath = await findApk(projectPath);
    const downloadName = `${slugify(appName)}-debug.apk`;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n=== Build OK in ${seconds}s → ${apkPath} (served as ${downloadName}) ===`);

    res.download(apkPath, downloadName, (err) => {
      if (err) console.error(`APK download failed: ${err.message}`);
    });
  } catch (err) {
    const isApiError = err instanceof ApiError;
    if (!isApiError) console.error('Unexpected pipeline error:', err);

    const payload = {
      success: false,
      error: isApiError ? err.message : 'Unexpected server error while building the APK.',
    };
    if (isApiError && err.log) payload.log = err.log;

    if (!res.headersSent && !res.writableEnded) {
      try {
        res.status(isApiError ? err.status : 500).json(payload);
      } catch (_) { /* socket already gone */ }
    }
  } finally {
    /* -- 9. Strict cleanup — always, success or failure ------------------- */
    const jobs = [];
    if (uploadedFile) jobs.push(fse.remove(uploadedFile.path).catch(() => {}));
    if (workspace) jobs.push(fse.remove(workspace).catch(() => {}));
    await Promise.all(jobs);
    console.log(`Cleanup done for build started at ${new Date(startedAt).toISOString()}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    env: {
      node: process.version,
      javaHomeSet: Boolean(process.env.JAVA_HOME),
      javaValid: Boolean(
        process.env.JAVA_HOME &&
        fse.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'java'))
      ),
      androidHomeSet: Boolean(process.env.ANDROID_HOME),
      androidSdkPresent: Boolean(
        process.env.ANDROID_HOME &&
        fse.existsSync(path.join(process.env.ANDROID_HOME, 'platform-tools'))
      ),
    },
    limits: {
      maxUploadMB: MAX_UPLOAD_MB,
      maxUnpackedMB: MAX_UNPACKED_MB,
      buildTimeoutMin: BUILD_TIMEOUT_MIN,
    },
  });
});

app.post('/api/build-apk', (req, res, next) => {
  // Friendly error when the client posts something other than multipart.
  if (!req.is('multipart/form-data')) {
    return res.status(400).json({
      success: false,
      error: 'Expected a multipart/form-data upload. Please submit the form on the website.',
    });
  }

  upload.single('webAssets')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        const friendly =
          err.code === 'LIMIT_FILE_SIZE'
            ? `File too large. Maximum upload size is ${MAX_UPLOAD_MB} MB.`
            : err.code === 'LIMIT_UNEXPECTED_FILE'
              ? 'Unexpected upload field. Please submit the form on the website.'
              : `Upload error: ${err.message}`;
        return res.status(400).json({ success: false, error: friendly });
      }
      const status = err instanceof ApiError ? err.status : 500;
      return res.status(status).json({
        success: false,
        error: err.message || 'Upload failed.',
      });
    }
    handleBuildRequest(req, res).catch(next);
  });
});

/* -------------------------------------------------------------------------- */
/*  404 + central error handler                                               */
/* -------------------------------------------------------------------------- */

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'Unknown API endpoint.' });
});

app.use((req, res) => {
  res.redirect('/');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

/* -------------------------------------------------------------------------- */
/*  Startup                                                                   */
/* -------------------------------------------------------------------------- */

/** Non-fatal warnings about the Android build environment. */
function checkEnvironment() {
  const warnings = [];
  if (!process.env.JAVA_HOME) {
    warnings.push('JAVA_HOME is not set — Android builds will fail. See README.md (steps 2 & 5).');
  } else if (!fse.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'java'))) {
    warnings.push('JAVA_HOME does not point to a JDK installation — see README.md (step 2 & 5).');
  }
  if (!process.env.ANDROID_HOME) {
    warnings.push('ANDROID_HOME is not set — Android builds will fail. See README.md (steps 3 & 5).');
  } else if (!fse.existsSync(path.join(process.env.ANDROID_HOME, 'platform-tools'))) {
    warnings.push('ANDROID_HOME does not contain the SDK packages — see README.md (step 4).');
  }
  return warnings;
}

const server = app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`HTML → APK converter listening on http://${displayHost}:${PORT}`);
  const warnings = checkEnvironment();
  if (warnings.length) {
    console.log('\nEnvironment check found issues:');
    warnings.forEach((w) => console.log(`  - ${w}`));
  } else {
    console.log('Environment check passed: JAVA_HOME and ANDROID_HOME are configured.');
  }
});

// Android builds routinely run longer than Node's default request timeout —
// disable it (per-step hard timeouts are enforced in runCommand instead).
server.requestTimeout = 0;
server.timeout = 0;

/* -------------------------------------------------------------------------- */
/*  Graceful shutdown                                                         */
/* -------------------------------------------------------------------------- */

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
