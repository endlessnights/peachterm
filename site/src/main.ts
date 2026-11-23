// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Small, dependency-free behavior: mobile menu, screenshot lightbox and the
// theme preview tabs. Nothing here makes a network request.

const $ = <T extends Element>(selector: string, root: ParentNode = document) =>
  root.querySelector<T>(selector);

document.documentElement.classList.remove('no-js');

// ---- tab bar: highlight the section in view -----------------------------------------------
{
  const nav = $<HTMLElement>('#site-nav');
  const links = [...document.querySelectorAll<HTMLAnchorElement>('#site-nav a')];
  const targets = links
    .map((a) => document.getElementById(a.getAttribute('href')?.slice(1) ?? ''))
    .filter((el): el is HTMLElement => el !== null);
  const mark = (id: string) => {
    links.forEach((a) => {
      const on = a.getAttribute('href') === `#${id}`;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
    // keep the active tab visible when the bar scrolls sideways (small screens)
    const on = nav?.querySelector<HTMLElement>('a.on');
    if (nav && on && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
    }
  };
  const update = () => {
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
    let current = targets[0];
    for (const t of targets) if (t.getBoundingClientRect().top <= 80) current = t;
    if (atBottom) current = targets[targets.length - 1];
    if (current) mark(current.id);
  };
  let queued = false;
  document.addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    },
    { passive: true },
  );
  update();
}

// ---- screenshot lightbox ---------------------------------------------------------------
{
  const dialog = $<HTMLDialogElement>('#lightbox');
  const image = $<HTMLImageElement>('#lightbox-image');
  const caption = $('#lightbox-caption');
  const items = [...document.querySelectorAll<HTMLButtonElement>('#gallery button')];
  let index = 0;
  let opener: HTMLElement | null = null;

  const show = (i: number) => {
    const item = items[(i + items.length) % items.length];
    if (!item || !image || !caption) return;
    index = items.indexOf(item);
    image.src = item.dataset.full ?? '';
    image.alt = item.dataset.alt ?? '';
    caption.textContent = item.dataset.alt ?? '';
  };

  if (dialog && image) {
    items.forEach((button, i) =>
      button.addEventListener('click', () => {
        opener = button;
        show(i);
        dialog.showModal();
      }),
    );
    $('#lightbox-prev')?.addEventListener('click', () => show(index - 1));
    $('#lightbox-next')?.addEventListener('click', () => show(index + 1));
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') show(index - 1);
      if (e.key === 'ArrowRight') show(index + 1);
    });
    // a click on the dark backdrop closes it
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      image.removeAttribute('src');
      opener?.focus();
    });
  }
}

// ---- theme preview tabs ----------------------------------------------------------------
{
  const THEMES: Record<string, { file: string; alt: string; text: string }> = {
    dark: {
      file: 'split-dark',
      alt: 'PeachTerm split view in the Dark theme',
      text: 'Dark is the default: neutral near-black panels with a soft peach accent.',
    },
    light: {
      file: 'split-light',
      alt: 'PeachTerm split view in the Light theme',
      text: 'Light: warm off-white panels with the same layout and a readable terminal palette.',
    },
    olive: {
      file: 'split-olive',
      alt: 'PeachTerm split view in the Industrial Olive theme',
      text: 'Industrial Olive: muted olive panels, thin rectangular borders and a mustard highlight, with the matching Industrial Olive Console terminal palette.',
    },
    gray: {
      file: 'split-gray',
      alt: 'PeachTerm split view in the Source Gray theme',
      text: 'Source Gray: neutral grey panels and compact, flat controls, with the Source Gray Console terminal palette.',
    },
  };
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#theme-tabs [role="tab"]')];
  const panel = $<HTMLElement>('#theme-panel');
  const image = $<HTMLImageElement>('#theme-image');
  const caption = $('#theme-caption');

  const select = (tab: HTMLButtonElement, focus: boolean) => {
    const theme = THEMES[tab.dataset.theme ?? ''];
    if (!theme || !image || !caption || !panel) return;
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tab.id);
    image.src = `./screenshots/${theme.file}.webp`;
    image.alt = theme.alt;
    caption.textContent = theme.text;
    if (focus) tab.focus();
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', (e) => {
      const last = tabs.length - 1;
      const next =
        e.key === 'ArrowRight'
          ? i === last
            ? 0
            : i + 1
          : e.key === 'ArrowLeft'
            ? i === 0
              ? last
              : i - 1
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? last
                : -1;
      const target = tabs[next];
      if (target) {
        e.preventDefault();
        select(target, true);
      }
    });
  });
}
