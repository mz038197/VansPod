/** Keep the original brand artwork; animate its layers in the browser. */
export const connectionMascot = `<div class="connection-mascot">
  <div class="mascot-traveler">
  <div class="mascot-arrival">
    <button type="button" class="mascot-play" aria-label="和法鬥超人打招呼" title="和法鬥超人打招呼">
      <span class="mascot-idle">
        <span class="mascot-facing">
        <svg class="mascot-art" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
          <defs>
            <clipPath id="mascot-arm-clip"><path d="M85 320H220L235 400L222 462L241 508L254 530L207 589L149 522L104 451L85 410Z"/></clipPath>
            <mask id="mascot-arm-mask"><rect width="1024" height="1024" fill="white"/><path d="M85 320H220L235 400L222 462L241 508L254 530L207 589L149 522L104 451L85 410Z" fill="black"/></mask>
            <clipPath id="mascot-left-foot-clip"><rect x="235" y="915" width="175" height="100"/></clipPath>
            <clipPath id="mascot-right-foot-clip"><rect x="490" y="927" width="185" height="88"/></clipPath>
            <clipPath id="mascot-logo-clip"><rect x="283" y="612" width="315" height="105"/></clipPath>
            <filter id="mascot-logo-alpha" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
              <feColorMatrix in="SourceGraphic" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 32 -32 0 0.6" result="lettering"/>
              <feColorMatrix in="SourceGraphic" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 -16 0 0 3.5" result="outline"/>
              <feComposite in="lettering" in2="outline" operator="arithmetic" k2="1" k3="1" result="ink"/>
              <feComposite in="SourceGraphic" in2="ink" operator="in"/>
            </filter>
            <filter id="mascot-logo-erase" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
              <feColorMatrix in="SourceGraphic" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 32 -32 0 0.6" result="lettering"/>
              <feColorMatrix in="SourceGraphic" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -16 0 0 3.5" result="outline"/>
              <feComposite in="lettering" in2="outline" operator="arithmetic" k2="1" k3="1"/>
            </filter>
            <linearGradient id="mascot-shirt-fill"><stop stop-color="#3d6878"/><stop offset="0.5" stop-color="#3a677a"/><stop offset="1" stop-color="#356270"/></linearGradient>
            <mask id="mascot-detail-mask"><rect width="1024" height="1024" fill="white"/><rect x="235" y="915" width="175" height="100" fill="black"/><rect x="490" y="927" width="185" height="88" fill="black"/><image href="/fadou-superhero.png" width="1024" height="1024" clip-path="url(#mascot-logo-clip)" filter="url(#mascot-logo-erase)"/></mask>
            <clipPath id="mascot-body-clip"><path d="M0 0H1024V490H700L670 534L739 601L768 638L765 681L740 718L702 749L691 778L668 803L646 813V1024H0Z"/></clipPath>
            <clipPath id="mascot-cape-clip"><path d="M688 490L1024 490V850H640V789L670 760L704 730L744 679L744 620L668 545Z"/></clipPath>
            <clipPath id="mascot-eyes-clip"><ellipse cx="334" cy="359" rx="52" ry="43"/><ellipse cx="535" cy="369" rx="53" ry="43"/></clipPath>
          </defs>
          <g class="mascot-cape"><image href="/fadou-superhero.png" width="1024" height="1024" clip-path="url(#mascot-cape-clip)"/></g>
          <rect x="283" y="612" width="315" height="105" fill="url(#mascot-shirt-fill)"/>
          <g mask="url(#mascot-detail-mask)"><image href="/fadou-superhero.png" width="1024" height="1024" clip-path="url(#mascot-body-clip)" mask="url(#mascot-arm-mask)"/></g>
          <g class="mascot-foot mascot-left-foot"><image href="/fadou-superhero.png" width="1024" height="1024" clip-path="url(#mascot-left-foot-clip)"/></g>
          <g class="mascot-foot mascot-right-foot"><image href="/fadou-superhero.png" width="1024" height="1024" clip-path="url(#mascot-right-foot-clip)"/></g>
          <g class="mascot-logo"><image href="/fadou-superhero.png" width="1024" height="1024" clip-path="url(#mascot-logo-clip)" filter="url(#mascot-logo-alpha)"/></g>
          <g class="mascot-arm"><image href="/fadou-superhero.png" width="1024" height="1024" clip-path="url(#mascot-arm-clip)"/></g>
          <g class="mascot-blink" clip-path="url(#mascot-eyes-clip)"><image href="/fadou-superhero-blink.png" x="11" y="4" width="1024" height="1024"/></g>
        </svg>
        </span>
      </span>
    </button>
  </div>
  </div>
  <button type="button" class="mascot-pause" aria-label="暫停法鬥超人動畫" aria-pressed="false" title="暫停動畫"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
</div>`;

// One lap: centre → left (6s), rest (6s), right (12s), rest (6s), centre (6s).
// Both feet settle at each edge; no stepping in place during the rests.
function footstepKeyframes(name: string, direction: number): string {
  const frames: string[] = [];
  for (const [start, end] of [[0, 6], [12, 24], [30, 36]]) {
    for (let time = start; time <= end; time += 0.5) {
      const phase = (time - start) % 1;
      const angle = time === start || time === end ? 0 : (phase === 0.5 ? -5 : 5) * direction;
      frames.push(`${time / 36 * 100}% { transform: translateY(${angle < 0 ? -6 : 0}px) rotate(${angle}deg); }`);
    }
  }
  return `@keyframes ${name} { ${frames.join("\n")} }`;
}

export const connectionMascotStyles = `
  .settings-card[data-setting="連線"]:has(.connection-mascot) { row-gap: 0; }
  .settings-card[data-setting="連線"]:has(.connection-mascot) .settings-content { padding-top: 16px; }
  .settings-card[data-setting="連線"]:has(.connection-mascot) .connection-feedback { order: -1; }
  .connection-mascot { position: relative; flex: 1 0 144px; width: 100%; min-height: 144px; overflow: hidden; container-type: inline-size; }
  /* Compensate for the PNG's transparent space below the soles. */
  .mascot-traveler { position: absolute; bottom: -4px; left: 8px; width: 136px; max-width: calc(100% - 16px); animation: mascot-walk 36s linear 780ms infinite both; }
  .mascot-facing { display: block; animation: mascot-turn 36s linear 780ms infinite; }
  .mascot-logo { transform-origin: 440.5px 664.5px; animation: mascot-turn 36s linear 780ms infinite; }
  .mascot-left-foot { transform-origin: 322px 915px; animation: mascot-left-step 36s linear 780ms infinite; }
  .mascot-right-foot { transform-origin: 580px 927px; animation: mascot-right-step 36s linear 780ms infinite; }
  .mascot-waiting { flex-basis: 164px; min-height: 164px; padding: 12px 148px 32px 0; }
  .mascot-waiting .mascot-traveler { left: auto; right: 8px; transform: none; }
  .mascot-waiting .mascot-traveler, .mascot-waiting .mascot-facing, .mascot-waiting .mascot-logo, .mascot-waiting .mascot-foot, .mascot-waiting .mascot-arrival { animation: none; }
  .mascot-speech { position: relative; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--input); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  .mascot-speech:has(> .connection-feedback:empty) { display: none; }
  .mascot-speech::after { content: ''; position: absolute; right: -7px; top: 28px; width: 12px; height: 12px; background: var(--input); border-right: 1px solid var(--line); border-top: 1px solid var(--line); transform: rotate(45deg); }
  .mascot-quote { color: var(--text); }
  .mascot-speech .connection-error, .mascot-speech .connection-message { padding: 0; margin-top: 6px; border-radius: 0; background: transparent; color: var(--muted); font-size: 11px; }
  .mascot-speech .connection-error svg, .mascot-speech .connection-message svg { display: none; }
  main button.mascot-pause { position: absolute; right: 0; bottom: 0; display: grid; place-items: center; min-height: 24px; width: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); opacity: 0.65; }
  main button.mascot-pause:hover, main button.mascot-pause:focus-visible { opacity: 1; background: var(--input); }
  .connection-mascot:hover .mascot-traveler, .connection-mascot:hover .mascot-facing, .connection-mascot:hover .mascot-logo, .connection-mascot:hover .mascot-foot,
  .connection-mascot:focus-within .mascot-traveler, .connection-mascot:focus-within .mascot-facing, .connection-mascot:focus-within .mascot-logo, .connection-mascot:focus-within .mascot-foot,
  .connection-mascot[data-paused] * { animation-play-state: paused; }
  .mascot-arrival { animation: mascot-arrive 780ms cubic-bezier(0.22, 1, 0.36, 1) both; transform-origin: center bottom; }
  main button.mascot-play { display: block; width: 136px; max-width: 100%; min-height: 0; padding: 0; border: 0; border-radius: 16px; background: transparent; color: inherit; touch-action: manipulation; }
  .mascot-play:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .mascot-play:active { transform: scale(0.97); }
  .mascot-idle { display: block; user-select: none; transform-origin: 50% 97%; animation: mascot-breathe 3200ms ease-in-out 780ms infinite; }
  .mascot-art { display: block; width: 100%; height: auto; overflow: visible; }
  .mascot-cape { transform-origin: 680px 530px; animation: mascot-cape 2400ms ease-in-out infinite; }
  .mascot-arm { transform-origin: 235px 540px; }
  .mascot-blink { opacity: 0; animation: mascot-blink 7400ms steps(1, end) infinite; }
  @keyframes mascot-arrive {
    0% { opacity: 0; transform: translateY(16px) scale(0.9); }
    35% { opacity: 1; transform: translateY(-7px) scale(1.02); }
    60% { transform: translateY(2px) scale(0.99); }
    80% { transform: translateY(-2px) scale(1); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes mascot-breathe {
    0%, 100% { transform: translateY(0) scale(1); }
    50% { transform: scale(1.012, 1.018); }
  }
  @keyframes mascot-cape {
    0%, 100% { transform: rotate(0deg) scale(1); }
    50% { transform: rotate(-1.5deg) scale(1.012, 0.99); }
  }
  @keyframes mascot-blink {
    0%, 42%, 85%, 90%, 100% { opacity: 0; }
    40%, 83%, 88% { opacity: 1; }
  }
  @keyframes mascot-walk {
    0%, 100% { transform: translateX(max(0px, calc((100cqw - 152px) / 2))); }
    16.666667%, 33.333333% { transform: translateX(0); }
    66.666667%, 83.333333% { transform: translateX(max(0px, calc(100cqw - 152px))); }
  }
  @keyframes mascot-turn {
    0%, 16.666667% { transform: scaleX(1); }
    18%, 66.666667% { transform: scaleX(-1); }
    68%, 100% { transform: scaleX(1); }
  }
  ${footstepKeyframes("mascot-left-step", 1)}
  ${footstepKeyframes("mascot-right-step", -1)}
  @media (prefers-reduced-motion: reduce) {
    .mascot-arrival, .mascot-idle, .mascot-cape, .mascot-blink, .mascot-traveler, .mascot-facing, .mascot-logo, .mascot-foot { animation: none; }
    .mascot-traveler { left: 50%; transform: translateX(-50%); }
    .mascot-waiting .mascot-traveler { left: auto; transform: none; }
    main button.mascot-pause { display: none; }
    .mascot-play:active { transform: none; }
  }
  @media (prefers-contrast: more) { .mascot-play:focus-visible { outline-width: 3px; } }
`;

export const connectionMascotScript = `
  function mascotAnimationState() {
    var mascot = document.querySelector('.connection-mascot');
    return { paused: mascot?.hasAttribute('data-paused') || false, animations: mascot ? mascot.getAnimations({ subtree: true }).filter(function (animation) {
      return typeof animation.animationName === 'string';
    }).map(function (animation) {
      return { name: animation.animationName, time: animation.currentTime };
    }) : [] };
  }
  function restoreMascotAnimationState(state) {
    var mascot = document.querySelector('.connection-mascot');
    if (!mascot) return;
    if (state.paused) {
      mascot.setAttribute('data-paused', '');
      var pause = mascot.querySelector('.mascot-pause');
      pause.setAttribute('aria-pressed', 'true');
      pause.setAttribute('aria-label', '繼續法鬥超人動畫');
      pause.title = '繼續動畫';
    }
    mascot.getAnimations({ subtree: true }).forEach(function (animation) {
      var saved = (state.animations || []).find(function (value) { return value.name === animation.animationName; });
      if (saved && saved.time !== null) animation.currentTime = saved.time;
    });
  }
  document.addEventListener('click', function (event) {
    var pause = event.target.closest?.('.mascot-pause');
    if (pause && !pause.disabled) {
      var stage = pause.closest('.connection-mascot');
      var paused = stage.toggleAttribute('data-paused');
      pause.setAttribute('aria-pressed', String(paused));
      pause.setAttribute('aria-label', paused ? '繼續法鬥超人動畫' : '暫停法鬥超人動畫');
      pause.title = paused ? '繼續動畫' : '暫停動畫';
      return;
    }
    var button = event.target.closest?.('.mascot-play');
    if (!button || button.disabled) return;
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var arm = button.querySelector('.mascot-arm');
    arm.getAnimations().forEach(function (animation) { animation.cancel(); });
    if (!reduced) arm.animate([
      { transform: 'rotate(0deg)' }, { transform: 'rotate(-8deg)', offset: 0.25 },
      { transform: 'rotate(5deg)', offset: 0.5 }, { transform: 'rotate(-6deg)', offset: 0.75 },
      { transform: 'rotate(0deg)' }
    ], { duration: 800, easing: 'ease-in-out' });
    button.getAnimations().forEach(function (animation) { animation.cancel(); });
    button.animate(reduced ? [{ opacity: 0.65 }, { opacity: 1 }] : [
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: 'translateY(-8px) rotate(-4deg)', offset: 0.35 },
      { transform: 'translateY(-3px) rotate(3deg)', offset: 0.65 },
      { transform: 'translateY(0) rotate(0deg)' }
    ], { duration: reduced ? 180 : 600, easing: 'ease-out' });
  });
`;
