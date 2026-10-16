# HTML → APK Converter (MVP)

Turn any static website — plain **HTML / CSS / JavaScript** — into a ready-to-install,
debug-signed **Android APK**, entirely from your own server.

The system is a classic client–server architecture:

```
┌────────────────────────┐         multipart/form-data          ┌──────────────────────────────┐
│  Browser (vanilla      │  ──────────────────────────────────► │  Node.js + Express backend   │
│  HTML/CSS/JS frontend) │                                      │                              │
│                        │  ◄────────────────────────────────── │  1. multer stores the .zip   │
│  index.html            │      app-debug.apk (binary stream)   │  2. npx cordova create       │
│  • form + validation   │                                      │  3. extract zip into www/    │
│  • status indicator    │                                      │  4. platform add android     │
│  • Fetch API download  │                                      │  5. cordova build android    │
└────────────────────────┘                                      └──────────────────────────────┘
```

Every build runs inside a **unique, timestamped temporary workspace** (no concurrent
collisions), and the workspace plus the uploaded archive are **always deleted** in a
`finally` block — success or failure.

---

## Repository layout

| File         | Purpose                                                        |
|--------------|----------------------------------------------------------------|
| `index.html` | Frontend — pure HTML5/CSS3/vanilla JS, zero frameworks         |
| `server.js`  | Backend — Express build pipeline driving Apache Cordova        |
| `README.md`  | This guide                                                     |

**Dependencies:** `express`, `multer`, `cors`, `fs-extra`, `adm-zip` (plus
`child_process`, built into Node.js, for shell execution). Cordova itself is
invoked via `npx cordova` — nothing global to install.

---

## Requirements

| Component            | Version                       | Notes                                    |
|----------------------|-------------------------------|------------------------------------------|
| OS                   | Ubuntu 20.04+ / Debian 11+ / WSL2 (Ubuntu) | Windows users: use WSL2      |
| Node.js              | **≥ 20.5**                    | Required by cordova-android 14           |
| OpenJDK              | **17** (JDK, not JRE)         | Required by the Android Gradle Plugin    |
| Android SDK          | Platform **35**, Build-Tools **35.0.0** | Required by cordova-android 14 |
| Gradle               | *(none — auto-managed)*       | Cordova uses the Gradle wrapper (8.13)   |
| Disk space           | ≥ 10 GB free                  | SDK ≈ 3–5 GB, Gradle/Maven caches ≈ 2 GB |
| Internet             | Required for first build      | Gradle + Maven dependencies download     |

> **Windows users:** install [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)
> (`wsl --install -d Ubuntu`) and run everything inside the Linux environment.
> Do **not** use `/mnt/c/...` paths for the SDK or Gradle caches — builds on the
> 9P filesystem are 5–10× slower. Keep everything under the Linux home directory.

---

## Step 0 — System preparation

```bash
sudo apt update
sudo apt install -y curl unzip git ca-certificates
```

## Step 1 — Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify (expect v20.x or newer)
node -v
npm -v
```

## Step 2 — Install OpenJDK 17

```bash
sudo apt install -y openjdk-17-jdk

# Verify (expect "openjdk version 17.x.x")
java -version
```

The Android Gradle Plugin used by cordova-android 14 requires **Java 17**.
If your system has multiple JDKs, make 17 the default:

```bash
sudo update-alternatives --config java   # pick the java-17-openjdk entry
```

## Step 3 — Download the Android Command-Line Tools

```bash
# Standard SDK location
mkdir -p ~/Android/Sdk/cmdline-tools

# Command-line tools v19 (latest at the time of writing — check
# https://developer.android.com/studio#command-line-tools-only for a newer build number)
cd /tmp
wget https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip

# The zip extracts to a folder named "cmdline-tools" — rename it to "latest"
unzip -q commandlinetools-linux-13114758_latest.zip -d ~/Android/Sdk/cmdline-tools
mv ~/Android/Sdk/cmdline-tools/cmdline-tools ~/Android/Sdk/cmdline-tools/latest

# Verify (expect a version number, e.g. 19.0)
~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --version
```

## Step 4 — Install the SDK packages

```bash
# Accept all licenses first (re-run after any new package install)
yes | ~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --licenses

# Install everything cordova-android 14 needs:
#   platform-tools (adb, fastboot), platforms;android-35, build-tools;35.0.0
~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0"

# Optional — only if you also want to build with older cordova-android 13:
#   "platforms;android-34" "build-tools;34.0.0"

# Verify
~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --list_installed
```

> Do **not** `apt install gradle` — Ubuntu's Gradle is too old and breaks the
> build. Cordova downloads the correct Gradle 8.13 wrapper automatically.

## Step 5 — Set JAVA_HOME and ANDROID_HOME permanently

Add the environment variables to your shell profile:

```bash
cat >> ~/.bashrc << 'EOF'

# ---- Android build environment (HTML → APK converter) ----
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
export PATH=$PATH:$ANDROID_HOME/platform-tools
export PATH=$PATH:$ANDROID_HOME/emulator
EOF

source ~/.bashrc
```

If you use **zsh**, write to `~/.zshrc` instead (same block).

Verify everything resolves:

```bash
echo "JAVA_HOME     = $JAVA_HOME"     # /usr/lib/jvm/java-17-openjdk-amd64
echo "ANDROID_HOME  = $ANDROID_HOME"  # /home/you/Android/Sdk
which sdkmanager                      # .../Android/Sdk/cmdline-tools/latest/bin/sdkmanager
adb --version                         # Android Debug Bridge version 1.0.41+
java -version                         # 17.x
```

## Step 6 — Run the converter

```bash
cd html-to-apk
npm install
npm start
```

Expected output:

```
HTML → APK converter listening on http://localhost:3000
Environment check passed: JAVA_HOME and ANDROID_HOME are configured.
```

Open **http://localhost:3000** in your browser.
If the startup log instead lists environment warnings, revisit steps 2–5
(you can also `curl -s http://localhost:3000/healthz` for a machine-readable check).

To listen on a different port or interface:

```bash
PORT=8080 HOST=127.0.0.1 npm start
```

## Step 7 — Convert your first website

1. Zip your website so that **`index.html` sits at the root of the archive**
   (select the files *inside* the site folder, not the folder itself — although
   the server also auto-flattens a single top-level folder as a convenience):

   ```bash
   cd /path/to/my-site
   zip -r ../my-site.zip .        # correct: archive root contains index.html
   ```

2. Fill in **App Name** (e.g. `My Site`), **Package ID** (e.g. `com.mysite.app`),
   attach the `.zip`, and press **Build APK**.

3. The first build downloads Gradle 8.13 + Maven dependencies and typically takes
   **10–20 minutes**; later builds take 2–5 minutes. The `.apk` downloads
   automatically when done — copy it to a phone, enable *Install unknown apps*,
   and install. Debug APKs are signed automatically with Android's debug keystore
   (generated on first build) — perfect for testing, not for the Play Store.

---

## Configuration (environment variables)

| Variable            | Default | Purpose                                     |
|---------------------|---------|---------------------------------------------|
| `PORT`              | `3000`  | HTTP listen port                            |
| `HOST`              | `0.0.0.0` | Bind address                              |
| `MAX_UPLOAD_MB`     | `50`    | Maximum `.zip` upload size                  |
| `MAX_UNPACKED_MB`   | `300`   | Maximum unpacked archive size (zip-bomb guard) |
| `BUILD_TIMEOUT_MIN` | `30`    | Hard timeout for `cordova build`            |

## API reference

### `POST /api/build-apk`

Multipart form data:

| Field       | Type | Rules                                                      |
|-------------|------|------------------------------------------------------------|
| `appName`   | text | required, ≤ 50 chars after sanitization                    |
| `packageId` | text | required, reverse-domain (≥ 2 segments), Java-safe         |
| `webAssets` | file | required, `.zip`, must contain `index.html` at root        |

**Success** → `200 OK`, binary APK stream with
`Content-Disposition: attachment; filename="my-site-debug.apk"`.

**Failure** → `400`/`500` JSON:

```json
{
  "success": false,
  "error": "Human-readable explanation of what went wrong.",
  "log": "Tail of the failed command's stdout/stderr (only for build errors)."
}
```

Example with `curl`:

```bash
curl -s -X POST http://localhost:3000/api/build-apk \
  -F "appName=My Site" \
  -F "packageId=com.mysite.app" \
  -F "webAssets=@/path/to/my-site.zip" \
  -o my-site-debug.apk -D -
```

### `GET /healthz`

Returns server status, Node version, and whether `JAVA_HOME` / `ANDROID_HOME`
are configured — useful for automated checks.

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `sdkmanager: command not found` | Environment variables not loaded — re-run `source ~/.bashrc`, verify step 5 (`echo $ANDROID_HOME`). |
| `You have not accepted the license agreements` | Run `yes | sdkmanager --licenses`, then retry. |
| `Unsupported class file major version` / `Could not determine java version` | Wrong Java version. Check `java -version` shows 17 and `JAVA_HOME` points to `java-17-openjdk-amd64`. |
| `Failed to find target with hash string 'android-35'` | SDK platform missing — install `platforms;android-35` (step 4). |
| `Could not find build-tools 35.0.0` | Install `build-tools;35.0.0` (step 4). |
| Build hangs at a telemetry question | The server already passes `--no-telemetry` and `CI=1`; if you run Cordova manually, always add `--no-telemetry`. |
| Gradle download stalls / `Could not resolve` | Check internet/proxy. Corporate proxies: configure `systemProp.https.proxyHost/Port` in `~/.gradle/gradle.properties`. |
| Build killed / out of memory | Limit JVM heap: add `org.gradle.jvmargs=-Xmx2048m` to `~/.gradle/gradle.properties`, and avoid parallel builds on small VPS. |
| Very slow builds on Windows | You are building on `/mnt/c`. Keep the SDK, projects, and Gradle caches in the WSL2 Linux filesystem (`~/...`). |
| `npx cordova` fails with network errors | npm registry unreachable. Test `npm ping`; configure proxy or mirror. |
| Check disk space | `df -h ~` — the SDK and Gradle caches need several GB. |

## Production hardening (optional, beyond MVP scope)

- Put the app behind **nginx/Caddy with HTTPS** and keep it off the public
  internet if you do not add authentication — anyone who can reach the endpoint
  can consume your CPU.
- Add **authentication and rate limiting** (e.g. `express-rate-limit`), and
  consider a build queue to cap concurrent Cordova builds.
- Run the service in a **container** or dedicated VM; builds execute arbitrary
  archived web content only as passive assets, but resource exhaustion is real.
- For store-ready releases you need your own **keystore** and a release build
  (`cordova build android --release` + `apksigner`) — the MVP intentionally
  produces debug-signed APKs only.

## Notes & limitations

- The APK is a **Cordova WebView shell** around your site: `index.html` loads
  in a system WebView. No Cordova plugins are added, so native device APIs
  (camera, geolocation…) are not available in this MVP.
- Sites relying on **server-side backends** must expose those backends over the
  internet; only static assets are bundled.
- The service performs one build per request with full workspace isolation —
  concurrent requests are supported, but each build needs ~1 CPU core and
  ~2 GB RAM. Scale vertically or queue requests for heavy usage.
