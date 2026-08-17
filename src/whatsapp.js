export function createWhatsAppService({ store }) {
  async function status() {
    return store.read().whatsapp || { ready: false, qr: "", mode: "demo", message: "WhatsApp not linked." };
  }

  async function connect() {
    const qr = await createDemoQr();
    const next = { ready: false, qr, mode: "demo", message: "Demo QR generated. Replace with whatsapp-web.js session in production." };
    store.update((state) => { state.whatsapp = next; });
    return next;
  }

  async function logout() {
    const next = { ready: false, qr: "", mode: "demo", message: "WhatsApp session disconnected." };
    store.update((state) => { state.whatsapp = next; });
    return next;
  }

  return { status, connect, logout };
}

async function createDemoQr() {
  const text = `ReachFly demo WhatsApp session ${Date.now()}`;
  try {
    const qrcode = await import("qrcode");
    return qrcode.default.toDataURL(text, { margin: 1, width: 260 });
  } catch {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260"><rect width="260" height="260" rx="24" fill="#fff"/><rect x="30" y="30" width="70" height="70" fill="#17111f"/><rect x="160" y="30" width="70" height="70" fill="#17111f"/><rect x="30" y="160" width="70" height="70" fill="#17111f"/><text x="130" y="136" text-anchor="middle" font-family="Arial" font-size="14" fill="#7b42ff">ReachFly QR</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }
}
