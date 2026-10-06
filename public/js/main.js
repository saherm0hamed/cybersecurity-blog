// Mobile menu toggle
document.addEventListener('DOMContentLoaded', () => {
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (finePointer) {
    const cursorTracker = document.createElement('div');
    cursorTracker.className = 'cursor-tracker';
    cursorTracker.setAttribute('aria-hidden', 'true');
    cursorTracker.innerHTML = '<span class="cursor-tracker-axis cursor-tracker-x"></span><span class="cursor-tracker-axis cursor-tracker-y"></span>';
    document.body.appendChild(cursorTracker);

    window.addEventListener('pointermove', (event) => {
      cursorTracker.style.setProperty('--cursor-x', `${event.clientX}px`);
      cursorTracker.style.setProperty('--cursor-y', `${event.clientY}px`);
      cursorTracker.classList.add('is-visible');
    }, { passive: true });

    window.addEventListener('pointerleave', () => cursorTracker.classList.remove('is-visible'));
    window.addEventListener('blur', () => cursorTracker.classList.remove('is-visible'));
  }

  const readingProgress = document.getElementById('reading-progress');
  const articleContent = document.querySelector('.prose-custom');
  if (readingProgress && articleContent) {
    const progressFill = readingProgress.querySelector('span');
    let progressFramePending = false;

    const updateReadingProgress = () => {
      const contentRect = articleContent.getBoundingClientRect();
      const contentTop = window.scrollY + contentRect.top;
      const contentBottom = contentTop + contentRect.height;
      const navbarHeight = document.querySelector('.site-navbar')?.getBoundingClientRect().height || 0;
      const start = contentTop - navbarHeight;
      const end = Math.max(start, contentBottom - window.innerHeight);
      const progress = end === start
        ? (window.scrollY >= start ? 100 : 0)
        : Math.min(100, Math.max(0, ((window.scrollY - start) / (end - start)) * 100));
      const roundedProgress = Math.round(progress);

      progressFill.style.width = `${progress}%`;
      readingProgress.setAttribute('aria-valuenow', String(roundedProgress));
      readingProgress.setAttribute('aria-valuetext', `${roundedProgress} percent read`);
    };

    const scheduleProgressUpdate = () => {
      if (progressFramePending) return;
      progressFramePending = true;
      window.requestAnimationFrame(() => {
        progressFramePending = false;
        updateReadingProgress();
      });
    };

    scheduleProgressUpdate();
    window.addEventListener('scroll', scheduleProgressUpdate, { passive: true });
    window.addEventListener('resize', scheduleProgressUpdate);
    window.addEventListener('load', scheduleProgressUpdate, { once: true });
  }

  const tocSidebar = document.querySelector('[data-toc-sidebar]');
  const tocList = tocSidebar?.querySelector('[data-toc-list]');
  if (tocSidebar && tocList && articleContent) {
    const headings = Array.from(articleContent.querySelectorAll('h2, h3, h4'));
    const headingSet = new Set(headings);
    const usedIds = new Set(Array.from(document.querySelectorAll('[id]'))
      .filter((element) => !headingSet.has(element))
      .map((element) => element.id));
    const tocLinks = [];

    headings.forEach((heading, index) => {
      const baseId = heading.textContent
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-') || `section-${index + 1}`;
      let headingId = heading.id || `post-${baseId}`;
      let suffix = 2;
      while (usedIds.has(headingId)) {
        headingId = `post-${baseId}-${suffix}`;
        suffix += 1;
      }
      heading.id = headingId;
      usedIds.add(headingId);

      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#${headingId}`;
      link.textContent = heading.textContent.trim();
      link.className = `toc-sidebar-link${heading.tagName === 'H2' ? '' : ' toc-sidebar-subheading'}`;
      item.append(link);
      tocList.append(item);
      tocLinks.push({ heading, link });
    });

    if (tocLinks.length) {
      tocSidebar.hidden = false;
      let activeFramePending = false;

      const updateActiveHeading = () => {
        activeFramePending = false;
        const navbarHeight = document.querySelector('.site-navbar')?.getBoundingClientRect().height || 0;
        const activationLine = navbarHeight + 32;
        let activeItem = tocLinks[0];

        for (const item of tocLinks) {
          if (item.heading.getBoundingClientRect().top > activationLine) break;
          activeItem = item;
        }

        tocLinks.forEach(({ link }) => {
          const isActive = link === activeItem.link;
          link.classList.toggle('is-active', isActive);
          if (isActive) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        });
      };

      const scheduleActiveHeadingUpdate = () => {
        if (activeFramePending) return;
        activeFramePending = true;
        window.requestAnimationFrame(updateActiveHeading);
      };

      scheduleActiveHeadingUpdate();
      window.addEventListener('scroll', scheduleActiveHeadingUpdate, { passive: true });
      window.addEventListener('resize', scheduleActiveHeadingUpdate);
    }
  }

  const pageSlug = document.body.dataset.postSlug || '';
  if (pageSlug) {
    const fingerprintPayload = {
      slug: pageSlug,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      screenResolution: typeof screen !== 'undefined' && screen.width && screen.height
        ? `${screen.width}x${screen.height}`
        : '',
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      colorDepth: typeof screen !== 'undefined' && screen.colorDepth ? String(screen.colorDepth) : '',
      deviceMemory: navigator.deviceMemory ? `${navigator.deviceMemory} GB` : '',
      cpuCores: navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : ''
    };

    fetch('/api/visit-fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(fingerprintPayload)
    }).catch(() => {});
  }

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    const themeThumb = document.getElementById('theme-toggle-thumb');
    const darkCodeTheme = document.getElementById('highlight-theme-dark');
    const lightCodeTheme = document.getElementById('highlight-theme-light');
    let isDark = document.documentElement.classList.contains('dark');

    try {
      const savedTheme = localStorage.getItem('blog-theme');
      if (savedTheme === 'dark' || savedTheme === 'light') isDark = savedTheme === 'dark';
    } catch {}

    const applyTheme = (dark, save = false) => {
      isDark = dark;
      document.documentElement.classList.toggle('dark', isDark);
      themeToggle.setAttribute('aria-checked', String(isDark));
      themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
      themeToggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
      if (themeThumb) themeThumb.classList.toggle('translate-x-5', isDark);
      if (darkCodeTheme) darkCodeTheme.disabled = !isDark;
      if (lightCodeTheme) lightCodeTheme.disabled = isDark;
      if (save) {
        try {
          localStorage.setItem('blog-theme', isDark ? 'dark' : 'light');
        } catch {}
      }
    };

    applyTheme(isDark);
    themeToggle.addEventListener('click', () => applyTheme(!isDark, true));
  }

  const likeForm = document.querySelector('[data-like-form]');
  if (likeForm) {
    const likeButton = likeForm.querySelector('[data-like-button]');
    const likeIcon = likeForm.querySelector('[data-like-icon]');
    const likeLabel = likeForm.querySelector('[data-like-label]');
    const likeCount = likeForm.querySelector('[data-like-count]');
    const likeFeedback = likeForm.querySelector('[data-like-feedback]');

    likeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (likeButton.disabled) return;

      likeButton.disabled = true;
      likeFeedback.textContent = '';
      likeFeedback.className = 'sr-only';

      try {
        const response = await fetch(likeForm.action, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !contentType.includes('application/json')) {
          throw new Error('Like request failed');
        }

        const result = await response.json();
        if (typeof result.liked !== 'boolean' || !Number.isInteger(result.likeCount)) {
          throw new Error('Invalid like response');
        }

        likeButton.setAttribute('aria-pressed', String(result.liked));
        likeIcon.textContent = result.liked ? '♥' : '♡';
        likeLabel.textContent = result.liked ? 'Liked' : 'Like this post';
        likeCount.textContent = String(result.likeCount);
        likeCount.setAttribute('aria-label', `${result.likeCount} likes`);
        likeButton.classList.toggle('text-red-300', result.liked);
        likeButton.classList.toggle('border-red-500/60', result.liked);
        likeButton.classList.toggle('text-gray-200', !result.liked);
        likeButton.classList.toggle('hover:text-white', !result.liked);
        likeButton.classList.toggle('hover:border-gray-400', !result.liked);
        likeFeedback.textContent = result.liked ? 'Post liked.' : 'Like removed.';
      } catch {
        likeFeedback.className = 'mt-2 text-sm text-red-300';
        likeFeedback.textContent = 'Could not update your like. Please try again.';
      } finally {
        likeButton.disabled = false;
      }
    });
  }

  document.querySelectorAll('.prose-custom pre > code').forEach((codeElement) => {
    const preElement = codeElement.parentElement;
    const wrapper = document.createElement('div');
    const copyButton = document.createElement('button');
    const rawLanguage = Array.from(codeElement.classList)
      .find((className) => className.startsWith('language-'))
      ?.replace(/^language-/, '') || 'code';
    const languageLabel = rawLanguage
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Code';

    wrapper.className = 'code-snippet';
    copyButton.type = 'button';
    copyButton.className = 'code-copy-button';
    copyButton.textContent = 'Copy';
    copyButton.setAttribute('aria-label', 'Copy code snippet');
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeElement.textContent || '');
        copyButton.textContent = 'Copied';
        window.setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500);
      } catch {
        copyButton.textContent = 'Copy failed';
        window.setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500);
      }
    });

    preElement.parentNode.insertBefore(wrapper, preElement);
    wrapper.append(preElement);
    wrapper.insertBefore(copyButton, preElement);
  });

  const showConfirmDialog = (message, onConfirm) => {
    const existing = document.querySelector('.confirm-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'confirm-dialog-title');
    modal.setAttribute('aria-describedby', 'confirm-dialog-message');
    modal.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog-accent"></div>
        <div class="confirm-dialog-header">
          <div class="confirm-dialog-symbol" aria-hidden="true"><span class="material-icons">warning_amber</span></div>
          <div class="confirm-dialog-heading">
            <h2 id="confirm-dialog-title">Confirm action</h2>
            <p>Review this action before continuing.</p>
          </div>
        </div>
        <div id="confirm-dialog-message" class="confirm-dialog-body">${message}</div>
        <div class="confirm-dialog-actions">
          <button type="button" class="confirm-close">Cancel</button>
          <button type="button" class="confirm-accept"><span class="material-icons" aria-hidden="true">delete</span>Delete</button>
        </div>
      </div>
    `;

    const close = () => {
      modal.classList.remove('is-open');
      setTimeout(() => modal.remove(), 180);
    };

    const confirmButton = modal.querySelector('.confirm-accept');
    const cancelButtons = modal.querySelectorAll('.confirm-close');
    confirmButton.addEventListener('click', () => {
      close();
      onConfirm();
    });
    cancelButtons.forEach((button) => button.addEventListener('click', close));
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));

    const firstButton = modal.querySelector('.confirm-close');
    firstButton?.focus();
  };

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (form.dataset.confirmInProgress === 'true') {
        form.dataset.confirmInProgress = 'false';
        return;
      }

      event.preventDefault();
      showConfirmDialog(form.dataset.confirm || 'Are you sure?', () => {
        form.dataset.confirmInProgress = 'true';
        form.submit();
      });
    });
  });

  const certificateViewer = document.querySelector('[data-certificate-viewer]');
  if (certificateViewer && typeof certificateViewer.showModal === 'function') {
    const viewerImage = certificateViewer.querySelector('[data-certificate-viewer-image]');
    const viewerTitle = certificateViewer.querySelector('[data-certificate-viewer-title]');
    const closeButton = certificateViewer.querySelector('[data-certificate-viewer-close]');

    document.querySelectorAll('[data-certificate-zoom]').forEach((trigger) => {
      trigger.addEventListener('click', () => {
        viewerImage.src = trigger.dataset.imageSrc;
        viewerImage.alt = trigger.dataset.imageAlt || 'Certificate image';
        viewerTitle.textContent = trigger.dataset.imageAlt || 'Certificate preview';
        certificateViewer.showModal();
      });
    });

    closeButton.addEventListener('click', () => certificateViewer.close());
    certificateViewer.addEventListener('click', (event) => {
      if (event.target === certificateViewer) certificateViewer.close();
    });
  }

  const backToTop = document.getElementById('back-to-top');
  if (backToTop) {
    const updateBackToTop = () => {
      const isVisible = window.scrollY >= 320;
      backToTop.classList.toggle('invisible', !isVisible);
      backToTop.setAttribute('aria-hidden', String(!isVisible));
      backToTop.tabIndex = isVisible ? 0 : -1;
    };

    updateBackToTop();
    window.addEventListener('scroll', updateBackToTop, { passive: true });
    backToTop.addEventListener('click', () => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
      backToTop.blur();
    });
  }

  const btn = document.getElementById('mobile-menu-btn');
  const menu = document.getElementById('mobile-menu');
  if (btn && menu) {
    const setMenuOpen = (isOpen) => {
      menu.hidden = !isOpen;
      btn.setAttribute('aria-expanded', String(isOpen));
      btn.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
    };

    btn.addEventListener('click', () => setMenuOpen(menu.hidden));
    menu.addEventListener('click', (event) => {
      if (event.target.closest('a')) setMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        setMenuOpen(false);
        btn.focus();
      }
    });
  }
});
