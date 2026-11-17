/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Cookie banners (privacy pack, Settings › Privacy › Hide cookie banners).
// Atelier's own small list of the consent tools most sites use, written here
// from each tool's public markup: the elements that make up its banner, its
// Reject all (or Only necessary) button when it has an unambiguous one, and
// the class it puts on the page to stop it scrolling. Main turns the list
// into an injected stylesheet of !important rules (taken out again when the
// person lets a site show its banner) and a
// small script that clicks Reject once, in an isolated world, so the site
// records a refusal and doesn't ask again. Optional downloaded lists
// (./cookieLists.ts) add more hiding rules; they never click anything.

export interface ConsentTool {
  id: string
  /** The banner, its dialog and its backdrop. */
  hide: readonly string[]
  /** The tool's own reject button; only buttons that refuse everything optional. */
  reject?: readonly string[]
  /** For tools that draw into a shadow root: the element that hosts it (the reject button is inside). */
  shadowHost?: string
  /** html or body while the banner shows, when the tool stops the page scrolling. */
  unlock?: readonly string[]
}

export const CONSENT_TOOLS: readonly ConsentTool[] = [
  { id: 'onetrust', hide: ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter'], reject: ['#onetrust-reject-all-handler'] },
  {
    id: 'cookiebot',
    hide: ['#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay'],
    reject: ['#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'],
    unlock: ['body.CybotCookiebotDialogActive'],
  },
  { id: 'didomi', hide: ['#didomi-host', '.didomi-popup-backdrop'], reject: ['#didomi-notice-disagree-button'], unlock: ['body.didomi-popup-open', 'html.didomi-popup-open'] },
  { id: 'usercentrics', hide: ['#usercentrics-root', '#usercentrics-cmp-ui'], shadowHost: '#usercentrics-root', reject: ['button[data-testid="uc-deny-all-button"]'] },
  { id: 'trustarc', hide: ['#truste-consent-track', '#consent_blackbar', '.truste_overlay', '.truste_box_overlay'], reject: ['#truste-consent-required'] },
  // TrustArc's newer popup (digitalocean.com): its box sits in a full-page wrapper on top of everything, which
  // stays there, empty and transparent, once the box is hidden (even after Decline). Left showing, it takes every
  // click and key. The buttons are in an open shadow root.
  { id: 'trustarc-popup', hide: ['.truste_cm_outerdiv'], shadowHost: '.trustarc_newcm_container', reject: ['#decline_all_button'] },
  { id: 'sourcepoint', hide: ['[id^="sp_message_container_"]'], unlock: ['html.sp-message-open'] },
  { id: 'quantcast', hide: ['#qc-cmp2-container', '.qc-cmp2-container'] },
  { id: 'funding-choices', hide: ['.fc-consent-root'], reject: ['.fc-cta-do-not-consent'] },
  { id: 'consentmanager', hide: ['#cmpbox', '#cmpbox2'], reject: ['.cmpboxbtnno'] },
  { id: 'iubenda', hide: ['#iubenda-cs-banner'], reject: ['.iubenda-cs-reject-btn'] },
  { id: 'cookieyes', hide: ['.cky-consent-container', '.cky-overlay'], reject: ['.cky-btn-reject'] },
  { id: 'complianz', hide: ['#cmplz-cookiebanner-container', '.cmplz-cookiebanner'], reject: ['.cmplz-btn.cmplz-deny'] },
  { id: 'osano', hide: ['.osano-cm-window'], reject: ['.osano-cm-denyAll'] },
  { id: 'cookieconsent', hide: ['.cc-window.cc-banner', '.cc-window.cc-floating'], reject: ['.cc-window .cc-deny'] },
  { id: 'cookie-script', hide: ['#cookiescript_injected', '#cookiescript_injected_wrapper'], reject: ['#cookiescript_reject'] },
  { id: 'cookie-notice', hide: ['#cookie-notice'], reject: ['#cn-refuse-cookie'] },
  { id: 'cookie-law-info', hide: ['#cookie-law-info-bar', '.cli-modal-backdrop'], reject: ['#cookie_action_close_header_reject'] },
  { id: 'moove-gdpr', hide: ['#moove_gdpr_cookie_info_bar'], reject: ['.moove-gdpr-infobar-reject-btn'] },
  { id: 'hubspot', hide: ['#hs-eu-cookie-confirmation'], reject: ['#hs-eu-decline-button'] },
  { id: 'shopify', hide: ['#shopify-pc__banner'], reject: ['#shopify-pc__banner__btn-decline'] },
  { id: 'klaro', hide: ['.klaro .cookie-notice', '.klaro .cookie-modal'], reject: ['.klaro .cn-decline'] },
  { id: 'axeptio', hide: ['#axeptio_overlay'], reject: ['#axeptio_btn_dismiss'] },
  { id: 'crownpeak', hide: ['#_evidon_banner', '#_evidon-background'], reject: ['#_evidon-decline-button'] },
  { id: 'borlabs', hide: ['#BorlabsCookieBox'] },
  // Common hand-made banners: ids that say what they are.
  { id: 'generic', hide: ['#cookie-banner', '#cookieBanner', '#cookie-consent-banner', '#gdpr-cookie-notice', '#cookie-bar'] },
]

/** The bundled list's hiding selectors, in list order. */
export function bundledHideSelectors(tools: readonly ConsentTool[] = CONSENT_TOOLS): string[] {
  return tools.flatMap((t) => t.hide)
}

/** Selectors a stylesheet can't hold or that could break out of their rule. */
function cssSafe(selector: string): boolean {
  return selector.length > 0 && selector.length <= 1000 && !/[{}<>]|\/\*|\*\//.test(selector) && !/:-abp-|:has-text|:xpath|:matches-css|:upward|:remove\(|:style\(/.test(selector)
}

/**
 * The stylesheet for a page: every hiding selector, in groups (one bad
 * selector drops only its own group), then the scroll unlocks, all
 * !important so the tool's own inline display and overflow lose.
 */
export function buildCss(hide: readonly string[], unlock: readonly string[] = [], groupSize = 64): string {
  const selectors = [...new Set(hide.filter(cssSafe))]
  const rules: string[] = []
  for (let i = 0; i < selectors.length; i += groupSize) rules.push(`${selectors.slice(i, i + groupSize).join(',\n')} { display: none !important; }`)
  const unlocks = [...new Set(unlock.filter(cssSafe))]
  if (unlocks.length) rules.push(`${unlocks.join(',\n')} { overflow: auto !important; }`)
  return rules.join('\n')
}

/** The bundled list's stylesheet. */
export function bundledCss(tools: readonly ConsentTool[] = CONSENT_TOOLS): string {
  return buildCss(bundledHideSelectors(tools), tools.flatMap((t) => t.unlock ?? []))
}

/** What the page script found: a banner on the page (hidden by the stylesheet) and whether it pressed Reject. */
export interface BannerResult {
  found: boolean
  rejected: boolean
}

export function isBannerResult(value: unknown): value is BannerResult {
  return typeof value === 'object' && value !== null && typeof (value as BannerResult).found === 'boolean' && typeof (value as BannerResult).rejected === 'boolean'
}

/**
 * The isolated-world script: watches the page for up to `waitMs` (consent
 * tools load late), presses the first reject button it finds once, and
 * resolves with what it saw. It touches nothing but those buttons.
 */
export function bannerScript(tools: readonly ConsentTool[] = CONSENT_TOOLS, waitMs = 8000): string {
  const hide = bundledHideSelectors(tools)
  const reject = tools.filter((t) => t.reject && !t.shadowHost).flatMap((t) => t.reject ?? [])
  const shadow = tools.filter((t) => t.shadowHost && t.reject).map((t) => ({ host: t.shadowHost, reject: t.reject }))
  return `(() => new Promise((resolve) => {
  const HIDE = ${JSON.stringify(hide)};
  const REJECT = ${JSON.stringify(reject)};
  const SHADOW = ${JSON.stringify(shadow)};
  const valid = (s) => { try { document.createDocumentFragment().querySelector(s); return true } catch { return false } };
  const hide = HIDE.filter(valid).join(',');
  const reject = REJECT.filter(valid);
  let found = false, rejected = false, done = false, observer = null, timer = 0;
  const press = (root) => {
    for (const s of reject) {
      const el = root.querySelector(s);
      if (el && typeof el.click === 'function') { el.click(); return true }
    }
    return false;
  };
  const look = () => {
    if (!found && hide && document.querySelector(hide)) found = true;
    if (!rejected) rejected = press(document);
    if (!rejected) for (const s of SHADOW) {
      const root = document.querySelector(s.host)?.shadowRoot;
      if (!root) continue;
      for (const r of s.reject) { const el = root.querySelector(r); if (el && typeof el.click === 'function') { el.click(); rejected = true; found = true; break } }
      if (rejected) break;
    }
    if (rejected) finish();
  };
  const finish = () => {
    if (done) return;
    done = true;
    if (observer) observer.disconnect();
    clearTimeout(timer);
    resolve({ found: found || rejected, rejected });
  };
  look();
  if (done) return;
  // At most four looks a second, however busy the page is.
  let queued = false;
  observer = new MutationObserver(() => {
    if (queued || done) return;
    queued = true;
    setTimeout(() => { queued = false; if (!done) look() }, 250);
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });
  timer = setTimeout(finish, ${Math.max(0, Math.floor(waitMs))});
}))()`
}
