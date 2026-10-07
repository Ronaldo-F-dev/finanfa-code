/** The page shown in the window while the local server starts: the logo breathing over a soft glow, a shimmering bar and a line of text. Plain CSS, no script. */
export function splashHtml(text: string): string {
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0f1115;color:#c9ced8;font:14px system-ui,sans-serif;overflow:hidden}
body{display:grid;place-items:center}
.box{display:flex;flex-direction:column;align-items:center;gap:26px;animation:in .6s ease-out both}
.logo{position:relative;width:84px;height:84px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(145deg,#4f7cff,#2a49c9);color:#fff;font-size:46px;font-weight:600;animation:breathe 2.4s ease-in-out infinite}
.logo::after{content:"";position:absolute;inset:-14px;border-radius:32px;background:radial-gradient(closest-side,#4f7cff55,transparent);z-index:-1;animation:glow 2.4s ease-in-out infinite}
.bar{width:140px;height:3px;border-radius:3px;background:#1d2230;overflow:hidden}
.bar i{display:block;height:100%;width:45%;border-radius:3px;background:linear-gradient(90deg,transparent,#6f93ff,transparent);animation:slide 1.3s ease-in-out infinite}
.text{letter-spacing:.02em;animation:fade 2.4s ease-in-out infinite}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
@keyframes glow{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes slide{from{transform:translateX(-120%)}to{transform:translateX(320%)}}
@keyframes fade{0%,100%{opacity:.55}50%{opacity:1}}
</style><div class="box"><div class="logo">₣</div><div class="bar"><i></i></div><div class="text">${text}</div></div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
