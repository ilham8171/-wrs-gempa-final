(() => {
  "use strict";
  if (document.getElementById("wrsAiLauncher")) return;

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/ai-chat.css?v=20261014-3";
  document.head.appendChild(style);

  const dock = document.createElement("div");
  dock.id = "wrsAiDock";
  dock.className = "wrs-ai-dock";

  const launcher = document.createElement("button");
  launcher.id = "wrsAiLauncher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Buka WRS GEMPA AI");
  launcher.innerHTML = '<span class="wrs-ai-spark">✦</span><span class="wrs-ai-label">AI GEMPA</span>';

  const tuck = document.createElement("button");
  tuck.id = "wrsAiTuck";
  tuck.type = "button";
  tuck.className = "wrs-ai-tuck";
  tuck.setAttribute("aria-label", "Kecilkan tombol AI GEMPA");
  tuck.title = "Kecilkan tombol agar peta lebih terlihat";
  tuck.textContent = "‹";

  const panel = document.createElement("section");
  panel.id = "wrsAiPanel";
  panel.className = "wrs-ai-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Asisten WRS GEMPA AI");
  panel.innerHTML = `
    <header class="wrs-ai-head">
      <div class="wrs-ai-mark">✳</div>
      <div class="wrs-ai-title"><strong>WRS GEMPA AI</strong><span>Asisten informasi kebencanaan</span></div>
      <button type="button" class="wrs-ai-close" aria-label="Tutup chat">×</button>
    </header>
    <div class="wrs-ai-notice">AI dapat keliru. Status gempa/tsunami harus merujuk informasi resmi BMKG/InaTEWS.</div>
    <div class="wrs-ai-messages" role="log" aria-live="polite">
      <div class="wrs-ai-msg assistant">Halo! Aku WRS GEMPA AI. Kamu bisa bertanya tentang magnitudo, kedalaman, riwayat, atau cara memahami data gempa. Aku akan memberi tahu jika data live tidak tersedia.</div>
    </div>
    <form class="wrs-ai-form">
      <label class="wrs-ai-sr" for="wrsAiInput">Pertanyaan untuk WRS GEMPA AI</label>
      <textarea id="wrsAiInput" maxlength="1200" rows="2" placeholder="Tanya tentang gempa…" required></textarea>
      <button type="submit" class="wrs-ai-send">Kirim ↑</button>
    </form>
    <div class="wrs-ai-foot">Didukung AI · Jangan jadikan jawaban AI sebagai peringatan resmi.</div>
  `;

  dock.append(launcher, tuck);
  document.body.append(dock, panel);
  const messages = panel.querySelector(".wrs-ai-messages");
  const form = panel.querySelector("form");
  const input = panel.querySelector("textarea");
  const send = panel.querySelector(".wrs-ai-send");

  function addMessage(text, kind) {
    const node = document.createElement("div");
    node.className = "wrs-ai-msg " + kind;
    node.textContent = text;
    messages.appendChild(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  }
  function setOpen(open) {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    if (open) input.focus();
  }
  let isTucked = false;
  function setTucked(tucked) {
    isTucked = tucked;
    dock.classList.toggle("wrs-ai-tucked", tucked);
    launcher.setAttribute("aria-label", tucked ? "Tampilkan tombol WRS GEMPA AI" : "Buka WRS GEMPA AI");
    tuck.setAttribute("aria-label", tucked ? "Tampilkan tombol AI GEMPA" : "Kecilkan tombol AI GEMPA");
    tuck.title = tucked ? "Tampilkan tombol AI GEMPA" : "Kecilkan tombol agar peta lebih terlihat";
  }
  // When minimized to an icon, a single tap must restore AND open the chat.
  launcher.addEventListener("click", () => {
    if (isTucked) {
      setTucked(false);
      setOpen(true);
      return;
    }
    setOpen(panel.hidden);
  });
  tuck.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    setTucked(true);
  });
  panel.querySelector(".wrs-ai-close").addEventListener("click", () => setOpen(false));

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || send.disabled) return;
    addMessage(message, "user");
    input.value = "";
    send.disabled = true;
    send.textContent = "…";
    const waiting = addMessage("Sedang menganalisis pertanyaan…", "assistant pending");
    try {
      const response = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ message })
      });
      const data = await response.json().catch(() => ({}));
      waiting.remove();
      if (!response.ok) throw new Error(data.error || "AI belum dapat menjawab. Coba lagi.");
      addMessage(data.answer + (data.liveCatalogAvailable ? "\\n\\nKonteks katalog live tersedia; tetap periksa sumber resmi." : "\\n\\nCatatan: katalog live tidak tersedia saat permintaan ini; jawaban bukan laporan gempa terkini."), "assistant");
    } catch (error) {
      waiting.remove();
      addMessage(error.message || "Koneksi AI terganggu. Coba lagi nanti.", "error");
    } finally {
      send.disabled = false;
      send.textContent = "Kirim ↑";
      input.focus();
    }
  });
})();