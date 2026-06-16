const $ = (id) => document.getElementById(id);
const core = window.SitkaPdfCore;

const fileInput = $("ebookFile");
const button = $("openPrintViewButton");
const statusBox = $("status");

function options() {
  return {
    font: $("font").value,
    headingFont: $("headingFont").value,
    paperSize: $("paperSize").value,
    fontSize: Number($("fontSize").value || 16),
    margin: Number($("margin").value || 36),
    lineHeight: $("lineHeight").value || "1.35"
  };
}

function status(text) {
  statusBox.textContent = text;
}

function selectedFile() {
  return fileInput.files && fileInput.files[0];
}

function describe(file) {
  if (!file) return "Ready.";
  const kind = core.detectFileKind(file);
  if (kind !== "epub" && kind !== "mobi") return `${file.name} · unsupported`;
  return `${file.name} · ${core.humanBytes(file.size)} · ready`;
}

async function openPrintView() {
  const file = selectedFile();
  if (!file) {
    status("Choose EPUB or MOBI first.");
    return;
  }

  button.disabled = true;
  status("Reading book...");

  try {
    const result = await core.convertFileToPrintableHtml(file, options());
    const url = URL.createObjectURL(new Blob([result.html], { type: "text/html;charset=utf-8" }));
    const opened = window.open(url, "_blank", "noopener,noreferrer");

    status([
      opened ? "Print view opened." : "Popup blocked print view.",
      `Title: ${result.metadata.title || "(untitled)"}`,
      `Sections: ${result.sectionsCount}`,
      ...result.warnings.map((warning) => `Note: ${warning}`)
    ].join("\n"));

    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    status(error && error.message ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
}

fileInput.addEventListener("change", () => status(describe(selectedFile())));
button.addEventListener("click", openPrintView);
