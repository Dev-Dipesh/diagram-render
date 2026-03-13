import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "canopy", version: "1.0.0" });

function show(text) {
  const el = document.getElementById("msg");
  if (el) el.textContent = text;
}

app.ontoolinput = () => show("Rendering\u2026");

app.ontoolresult = async ({ structuredContent }) => {
  const { imageId, title } = structuredContent ?? {};
  if (!imageId) {
    show("No image ID in result.");
    return;
  }
  show("Loading\u2026");
  try {
    const result = await app.callServerTool({
      name: "get_diagram_image",
      arguments: { id: imageId },
    });
    const { data, mimeType } = JSON.parse(result.content[0].text);
    const img = document.createElement("img");
    img.src = `data:${mimeType};base64,${data}`;
    img.alt = title || "diagram";
    img.onload = () => document.getElementById("msg")?.replaceWith(img);
    img.onerror = () => show("\u26a0 Failed to display image.");
  } catch (err) {
    show("Error: " + err.message);
  }
};

await app.connect(new PostMessageTransport());
show("Waiting for diagram\u2026");
