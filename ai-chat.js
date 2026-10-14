(() => {
  "use strict";
  if (document.getElementById("wrsAiLauncher")) return;

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/ai-chat.css";
  document.head.appendChild(style);

  const launcher = document.createElement("button");
  launcher.id = "wrsAiLauncher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Buka WRS GEMPA AI");
  launcher.innerHTML = '<span class="wrs-ai-spark">✦</span><span>AI GEMPA</span>';

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

  document.body.append(launcher, panel);
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
  launcher.addEventListener("click", () => setOpen(panel.hidden));
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
      addMessage(data.answer + (data.liveCatalogAvailable ? "\n\nKonteks katalog live tersedia; tetap periksa sumber resmi." : "\n\nCatatan: katalog live tidak tersedia saat permintaan ini; jawaban bukan laporan gempa terkini."), "assistant");
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
