# Sitka PDF Converter Chrome Extension

This folder is the publish-oriented Chrome-only build.

It does not use Native Messaging, Python, Calibre, absolute local paths, or files outside the extension package. The user selects an EPUB or MOBI through Chrome's file picker. The extension reads the selected file in the browser, builds a Sitka-styled print view, and the user can use Chrome's **Print > Save as PDF** workflow.

## Current scope

- Supported input: DRM-free `.epub` and `.mobi`.
- Output: print-ready HTML opened in Chrome.
- Direct programmatic PDF generation is not implemented yet.
- MOBI support is experimental. It extracts text from MOBI text records; advanced Kindle layout features, images, links, and HUFF/CDIC-compressed files are not fully supported.
- The popup includes selectable common fonts, including Sitka, Georgia, Times New Roman, Cambria, Arial, Segoe UI, Calibri, Verdana, Microsoft YaHei, SimSun, and Noto CJK fallbacks.
- Sitka font files are not bundled. If Sitka is installed on the user's system, Chrome can use it in the print view. Otherwise, the CSS falls back to standard serif and CJK fonts.

## Install locally for testing

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder:

   ```text
   sitka_pdf_converter/chrome_extension
   ```

6. Click the extension icon.
7. Pick a DRM-free EPUB or MOBI.
8. Click **Open print view**.
9. In the generated page, use Chrome Print and choose **Save as PDF**.

## Publication notes

- The manifest uses Manifest V3.
- No extension permissions are declared.
- No book files or local file paths are stored.
- No remote JavaScript is loaded.
- No native host is required.

## Developer test command

From the vault root:

```powershell
node .\sitka_pdf_converter\chrome_extension_tests\run_extreme_tests.mjs
```
