# Sitka PDF Converter

Chrome-only EPUB/MOBI to Sitka-styled print-view converter.

This project is now focused only on the Chrome extension in `chrome_extension/`. It does not use Calibre, Python, Native Messaging, local absolute file paths, or a separate desktop helper.

## What it does

- Lets the user choose a DRM-free `.epub` or `.mobi` through Chrome's file picker.
- Reads the book inside the browser.
- Creates a Sitka-styled print view.
- Lets the user use Chrome Print and choose **Save as PDF**.

## Current scope

- EPUB support is browser-only.
- MOBI support is experimental and text-focused.
- Encrypted or DRM-protected files are rejected.
- Direct programmatic PDF generation is not implemented yet.
- Common body and heading fonts can be selected from the popup.
- Sitka font files are not bundled. If Sitka is unavailable, Chrome falls back to standard serif and CJK fonts.

## Local testing

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select:

   ```text
   sitka_pdf_converter/chrome_extension
   ```

6. Pick a DRM-free EPUB or MOBI.
7. Click **Open print view**.
8. Use Chrome Print and choose **Save as PDF**.

## Developer tests

From the vault root:

```powershell
node .\sitka_pdf_converter\chrome_extension_tests\run_extreme_tests.mjs
```

The test harness is intentionally outside `chrome_extension/` so the extension package remains clean for future publishing.
