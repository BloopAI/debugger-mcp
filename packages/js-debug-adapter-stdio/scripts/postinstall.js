const https = require('https');
const fs = require('fs');
const path = require('path');
const tar = require('tar');

const ADAPTER_VERSION = '1.100.1';
const DOWNLOAD_URL = `https://github.com/microsoft/vscode-js-debug/releases/download/v${ADAPTER_VERSION}/js-debug-dap-v${ADAPTER_VERSION}.tar.gz`;
const TARGET_DIR = path.resolve(__dirname, '..', 'dist');
const TARBALL_PATH = path.join(TARGET_DIR, `js-debug-dap-v${ADAPTER_VERSION}.tar.gz`);

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err)); // Delete the file if download fails
    });
  });
}

async function main() {
  try {
    if (!fs.existsSync(TARGET_DIR)) {
      fs.mkdirSync(TARGET_DIR, { recursive: true });
    }

    console.log(`Downloading vscode-js-debug DAP server v${ADAPTER_VERSION} from ${DOWNLOAD_URL}...`);
    await downloadFile(DOWNLOAD_URL, TARBALL_PATH);
    console.log(`Downloaded to ${TARBALL_PATH}`);

    console.log(`Extracting ${TARBALL_PATH} to ${TARGET_DIR}...`);
    await tar.x({
      file: TARBALL_PATH,
      cwd: TARGET_DIR,
      strip: 1, // Strip the top-level directory from the tarball (assuming it's 'js-debug/')
    });
    console.log('Extraction complete.');

    // Clean up the tarball
    fs.unlinkSync(TARBALL_PATH);
    console.log('Cleaned up tarball.');

    console.log('vscode-js-debug DAP server setup complete.');
  } catch (error) {
    console.error('Error during postinstall script:', error);
    process.exit(1);
  }
}

main();