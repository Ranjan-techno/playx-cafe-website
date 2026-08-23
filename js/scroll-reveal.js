// Subtle scroll-in reveal for major homepage sections (marked with
// [data-reveal] in index.html). Progressive enhancement only: every section
// is fully visible by default via CSS, and this script only ever adds the
// "reveal-init" class that makes them fade/slide in - so a blocked or slow
// script never leaves content hidden. Respects prefers-reduced-motion.

const revealTargets = document.querySelectorAll('[data-reveal]');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (revealTargets.length && !prefersReducedMotion && 'IntersectionObserver' in window) {
  revealTargets.forEach((el) => el.classList.add('reveal-init'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });

  revealTargets.forEach((el) => observer.observe(el));
}
