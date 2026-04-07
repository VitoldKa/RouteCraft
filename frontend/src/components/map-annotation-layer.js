export class MapAnnotationLayer {
  constructor(map, { onSelect, onUpdate } = {}) {
    this.map = map;
    this.onSelect = onSelect;
    this.onUpdate = onUpdate;
    this.layer = L.layerGroup().addTo(map);
    this.annotations = [];
  }

  setAnnotations(annotations) {
    this.annotations = Array.isArray(annotations) ? annotations : [];
    this.redraw();
  }

  clear() {
    this.annotations = [];
    this.layer.clearLayers();
  }

  redraw() {
    this.layer.clearLayers();

    for (const annotation of this.annotations) {
      if (!this.isValidAnnotation(annotation)) continue;
      const marker = L.marker([annotation.lat, annotation.lon], {
        icon: this.createIcon(annotation),
        keyboard: false,
        draggable: true,
      }).addTo(this.layer);

      marker.bindTooltip(annotation.text, {
        sticky: true,
        direction: "top",
        opacity: 0.92,
      });

      marker.on("click", (event) => {
        L.DomEvent.stop(event);
        if (typeof this.onSelect === "function") this.onSelect(annotation);
      });

      marker.on("dragend", () => {
        const next = marker.getLatLng();
        if (typeof this.onUpdate === "function") {
          this.onUpdate({
            ...annotation,
            lat: Number(next.lat),
            lon: Number(next.lng),
          });
        }
      });
    }
  }

  createIcon(annotation) {
    const text = this.escapeHtml(annotation.text);
    const color = this.normalizeColor(annotation.color);
    const fontSize = this.normalizeFontSize(annotation.fontSize);
    const paddingY = Math.max(6, Math.round(fontSize * 0.45));
    const paddingX = Math.max(10, Math.round(fontSize * 0.65));
    const radius = Math.max(12, Math.round(fontSize * 0.85));
    const lineHeight = 1.25;
    const estimatedHeight = Math.round(fontSize * lineHeight + paddingY * 2);
    return L.divIcon({
      className: "map-annotation-icon",
      html: `
        <div style="
          display: inline-block;
          max-width: 220px;
          padding: ${paddingY}px ${paddingX}px;
          border-radius: ${radius}px;
          border: 1px solid rgba(27, 42, 65, 0.18);
          background: rgba(255,255,255,0.96);
          color: ${color};
          font: 600 ${fontSize}px/1.25 Georgia, serif;
          box-shadow: 0 10px 26px rgba(20, 28, 40, 0.16);
          white-space: pre;
          box-sizing: border-box;
        ">${text}</div>
      `,
      iconAnchor: [Math.round(paddingX * 0.8), estimatedHeight],
    });
  }

  isValidAnnotation(annotation) {
    return (
      annotation &&
      Number.isFinite(Number(annotation.lat)) &&
      Number.isFinite(Number(annotation.lon)) &&
      typeof annotation.text === "string" &&
      annotation.text.trim().length > 0
    );
  }

  normalizeColor(value) {
    const color = typeof value === "string" ? value.trim() : "";
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : "#1B2A41";
  }

  normalizeFontSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size)) return 12;
    return Math.max(10, Math.min(32, Math.round(size)));
  }

  escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
}
