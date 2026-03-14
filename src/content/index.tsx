import React from "react";
import {createRoot, type Root} from "react-dom/client";
import browser from "webextension-polyfill";

import * as Constants from "@/shared/constants";
import {CargoEntry, PageContext} from "@/shared/types";
import * as Messaging from "@/messaging";
import {MessageType} from "@/messaging/type";
import {InlinePopup} from "@/content/InlinePopup";
import {InlineEmptyState} from "@/content/InlineEmptyState";
import {
  getInlinePopupInstruction,
  type InlinePopupInstruction,
} from "@/content/messageRouting";
import {
  extractAmazonMarketplaceProperties,
  extractEbayJsonLdProductProperties,
} from "@/lib/matching/ecommerce";

console.log(
  `${Constants.LOG_PREFIX} Content script loaded on:`,
  window.location.href,
);

const POPUP_ID = "crw-inline-alert";
const ASSET_URLS = {
  logo: browser.runtime.getURL("crw_logo.png"),
  settings: browser.runtime.getURL("settings.svg"),
  close: browser.runtime.getURL("close.svg"),
  external: browser.runtime.getURL("open-in-new.svg"),
};

let popupHost: HTMLDivElement | null = null;
let popupShadowMount: HTMLDivElement | null = null;
let popupRoot: Root | null = null;
let forcePopupVisible = false;
const CLOSE_TIMEOUT_MS = 5000;
let closeTimer: number | null = null;
let componentCloseHandler: (() => void) | null = null;

function clearCloseTimer() {
  if (closeTimer !== null) {
    console.log(
      `${Constants.LOG_PREFIX} Clearing close timer (id=` + String(closeTimer) + `)`,
    );
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function startCloseTimer() {
  clearCloseTimer();
  console.log(
    `${Constants.LOG_PREFIX} Starting close timer for ${CLOSE_TIMEOUT_MS}ms`,
  );
  closeTimer = window.setTimeout(() => {
    console.log(`${Constants.LOG_PREFIX} Close timer fired`);
    if (componentCloseHandler) {
      try {
        console.log(`${Constants.LOG_PREFIX} Invoking component close handler`);
        componentCloseHandler();
        return;
      } catch (err) {
        console.error(
          `${Constants.LOG_PREFIX} Error calling component close handler, falling back to removeInlinePopup`,
          err,
        );
      }
    }

    console.log(`${Constants.LOG_PREFIX} Falling back to removeInlinePopup`);
    removeInlinePopup();
  }, CLOSE_TIMEOUT_MS);
}

const handlePopupMouseOver = () => {
  console.log(`${Constants.LOG_PREFIX} Popup mouseover - pausing auto-close`);
  clearCloseTimer();
};

const handlePopupMouseOut = () => {
  console.log(`${Constants.LOG_PREFIX} Popup mouseout - resuming auto-close`);
  startCloseTimer();
};

const normalizeHostname = (hostname: string): string => {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
};

const getSuppressedDomains = async (): Promise<string[]> => {
  const stored = await browser.storage.local.get(
    Constants.STORAGE.SUPPRESSED_DOMAINS,
  );
  const value = stored[Constants.STORAGE.SUPPRESSED_DOMAINS];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeHostname(entry))
    .filter((entry) => entry.length > 0);
};

const isCurrentSiteSuppressed = async (): Promise<boolean> => {
  const domains = await getSuppressedDomains();
  const current = normalizeHostname(location.hostname || "");
  return current.length > 0 && domains.includes(current);
};

const normalizePageName = (pageName: string): string => {
  return pageName.trim().toLowerCase();
};

const getSuppressedPageNames = async (): Promise<string[]> => {
  const stored = await browser.storage.local.get(
    Constants.STORAGE.SUPPRESSED_PAGE_NAMES,
  );
  const value = stored[Constants.STORAGE.SUPPRESSED_PAGE_NAMES];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const suppressPageName = async (pageName: string): Promise<void> => {
  const trimmed = pageName.trim();
  const normalized = normalizePageName(pageName);
  if (!normalized) return;
  const names = await getSuppressedPageNames();
  if (names.some((name) => normalizePageName(name) === normalized)) return;
  await browser.storage.local.set({
    [Constants.STORAGE.SUPPRESSED_PAGE_NAMES]: [...names, trimmed],
  });
};

const unsuppressPageName = async (pageName: string): Promise<void> => {
  const normalized = normalizePageName(pageName);
  if (!normalized) return;
  const names = await getSuppressedPageNames();
  const next = names.filter((name) => normalizePageName(name) !== normalized);
  await browser.storage.local.set({
    [Constants.STORAGE.SUPPRESSED_PAGE_NAMES]: next,
  });
};

const isWarningsEnabled = async (): Promise<boolean> => {
  const stored = await browser.storage.local.get(
    Constants.STORAGE.WARNINGS_ENABLED,
  );
  const value = stored[Constants.STORAGE.WARNINGS_ENABLED];
  if (typeof value === "boolean") return value;
  return true;
};

const setWarningsEnabled = async (enabled: boolean): Promise<void> => {
  await browser.storage.local.set({
    [Constants.STORAGE.WARNINGS_ENABLED]: enabled,
  });
};

const openOptions = () => {
  void (async () => {
    try {
      await browser.runtime.openOptionsPage();
      return;
    } catch (directOpenError) {
      try {
        await browser.runtime.sendMessage(
          Messaging.createMessage(MessageType.OPEN_OPTIONS_PAGE, "content"),
        );
        return;
      } catch (messageOpenError) {
        const error =
          messageOpenError instanceof Error
            ? messageOpenError
            : directOpenError;
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("Extension context invalidated")) {
          window.alert(
            "The extension was updated or reloaded. Please refresh this page, then try opening settings again.",
          );
          return;
        }

        console.error(
          `${Constants.LOG_PREFIX} Failed to open options page`,
          error,
        );
      }
    }
  })();
};

const suppressCurrentSite = async (): Promise<void> => {
  const current = normalizeHostname(location.hostname || "");
  if (!current) return;
  const domains = await getSuppressedDomains();
  if (domains.includes(current)) return;
  await browser.storage.local.set({
    [Constants.STORAGE.SUPPRESSED_DOMAINS]: [...domains, current],
  });
};

const unsuppressCurrentSite = async (): Promise<void> => {
  const current = normalizeHostname(location.hostname || "");
  if (!current) return;
  const domains = await getSuppressedDomains();
  const next = domains.filter((domain) => domain !== current);
  await browser.storage.local.set({
    [Constants.STORAGE.SUPPRESSED_DOMAINS]: next,
  });
};

const ensurePopupRoot = (): Root => {
  if (popupRoot && popupHost?.isConnected && popupShadowMount?.isConnected) {
    console.log(`${Constants.LOG_PREFIX} Reusing existing popup root`);
    return popupRoot;
  }

  const existing = document.getElementById(POPUP_ID);
  if (existing) existing.remove();

  popupHost = document.createElement("div");
  popupHost.id = POPUP_ID;
  popupHost.style.all = "initial";
  popupHost.style.position = "static";
  popupHost.style.display = "block";

  const shadowRoot = popupHost.attachShadow({mode: "open"});
  const resetStyle = document.createElement("style");
  resetStyle.textContent = `
    :host {
      all: initial;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
  `;
  shadowRoot.appendChild(resetStyle);

  popupShadowMount = document.createElement("div");
  popupShadowMount.style.all = "initial";
  popupShadowMount.addEventListener("mouseover", handlePopupMouseOver);
  popupShadowMount.addEventListener("mouseout", handlePopupMouseOut);
  shadowRoot.appendChild(popupShadowMount);
  console.log(`${Constants.LOG_PREFIX} Created popup host and attached shadow mount`);

  document.documentElement.appendChild(popupHost);
  popupRoot = createRoot(popupShadowMount);
  console.log(`${Constants.LOG_PREFIX} Popup root created and mounted`);
  return popupRoot;
};

const removeInlinePopup = () => {
  console.log(`${Constants.LOG_PREFIX} removeInlinePopup called`);
  forcePopupVisible = false;
  if (popupRoot) {
    try {
      popupRoot.unmount();
      console.log(`${Constants.LOG_PREFIX} Unmounted popup root`);
    } catch (err) {
      console.error(`${Constants.LOG_PREFIX} Error unmounting popup root`, err);
    }
  }
  popupRoot = null;
  clearCloseTimer();
  if (popupShadowMount) {
    popupShadowMount.removeEventListener("mouseover", handlePopupMouseOver);
    popupShadowMount.removeEventListener("mouseout", handlePopupMouseOut);
    console.log(`${Constants.LOG_PREFIX} Removed popup mouse listeners`);
  }
  popupShadowMount = null;
  if (popupHost?.isConnected) {
    popupHost.remove();
    console.log(`${Constants.LOG_PREFIX} Removed popup host from DOM`);
  }
  popupHost = null;
  componentCloseHandler = null;
};

const renderInlinePopup = async (
  matches: CargoEntry[],
  ignorePreferences = false,
) => {
  const suppressedPageNames = await getSuppressedPageNames();
  const suppressedPageNameSet = new Set(
    suppressedPageNames.map((name) => normalizePageName(name)),
  );
  console.log(
    `${Constants.LOG_PREFIX} renderInlinePopup called: matches=${matches.length}, ignorePreferences=${ignorePreferences}, suppressedPageNames=${JSON.stringify(
      suppressedPageNames,
    )}`,
  );
  const filteredMatches =
    suppressedPageNameSet.size === 0
      ? matches
      : matches.filter((match) => {
        const normalizedPageName = normalizePageName(
          String(match.PageName || ""),
        );
        if (suppressedPageNameSet.has(normalizedPageName)) return false;

        if (
          match._type === "Product" ||
          match._type === "ProductLine" ||
          match._type === "Incident"
        ) {
          const normalizedCompany = normalizePageName(
            String(match.Company || ""),
          );
          if (
            normalizedCompany &&
            suppressedPageNameSet.has(normalizedCompany)
          ) {
            return false;
          }
        }

        return true;
      });

  const visibleMatches = ignorePreferences ? matches : filteredMatches;

  console.log(
    `${Constants.LOG_PREFIX} visibleMatches length=${visibleMatches.length}`,
  );

  if (visibleMatches.length === 0 && !ignorePreferences) {
    console.log(
      `${Constants.LOG_PREFIX} No visible matches and respecting preferences - removing popup`,
    );
    removeInlinePopup();
    return;
  }

  const currentlyWarningsEnabled = await isWarningsEnabled();

  if (!ignorePreferences && !currentlyWarningsEnabled) {
    console.log(
      `${Constants.LOG_PREFIX} Warnings are disabled by user preferences - removing popup`,
    );
    removeInlinePopup();
    return;
  }

  const currentlySuppressed = await isCurrentSiteSuppressed();
  if (!ignorePreferences && currentlySuppressed) {
    console.log(
      `${Constants.LOG_PREFIX} Current site is suppressed - removing popup`,
    );
    removeInlinePopup();
    return;
  }
  forcePopupVisible = ignorePreferences;
  const root = ensurePopupRoot();
  if (visibleMatches.length === 0) {
    const onCloseEmpty = () => {
      console.log(`${Constants.LOG_PREFIX} InlineEmptyState onClose invoked`);
      removeInlinePopup();
    };
    componentCloseHandler = onCloseEmpty;
    root.render(
      <InlineEmptyState
        logoUrl={ASSET_URLS.logo}
        settingsIconUrl={ASSET_URLS.settings}
        onOpenSettings={openOptions}
        onClose={onCloseEmpty}
      />,
    );
    return;
  }


  const handleDisableWarnings = async () => {
    if (ignorePreferences && !currentlyWarningsEnabled) {
      await setWarningsEnabled(true);
      void renderInlinePopup(visibleMatches, true);
      return;
    }

    await setWarningsEnabled(false);
    removeInlinePopup();
  };

  const topVisibleMatch = visibleMatches[0];
  const topVisiblePageName = String(topVisibleMatch?.PageName || "").trim();
  const topVisiblePageNameNormalized = normalizePageName(topVisiblePageName);
  const topVisibleCompanyName = String(topVisibleMatch?.Company || "").trim();
  const topVisibleCompanyNormalized = normalizePageName(topVisibleCompanyName);
  const topVisibleScopeType = topVisibleMatch?._type;
  console.log(
    `${Constants.LOG_PREFIX} Rendering InlinePopup: topMatch=${topVisiblePageName} company=${topVisibleCompanyName} type=${topVisibleScopeType}`,
  );
  const topVisibleTypeUsesCompanyToggle =
    topVisibleScopeType === "Product" ||
    topVisibleScopeType === "ProductLine" ||
    topVisibleScopeType === "Incident";
  const topVisiblePageSuppressed =
    Boolean(topVisiblePageNameNormalized) &&
    suppressedPageNameSet.has(topVisiblePageNameNormalized);
  const topVisibleCompanySuppressed =
    topVisibleTypeUsesCompanyToggle &&
    Boolean(topVisibleCompanyNormalized) &&
    suppressedPageNameSet.has(topVisibleCompanyNormalized);

  const getSuppressPageNameAction = () => {
    if (
      ignorePreferences &&
      topVisibleCompanySuppressed &&
      topVisibleCompanyName
    ) {
      return {
        label: "Show this company",
        run: async () => {
          await unsuppressPageName(topVisibleCompanyName);
          void renderInlinePopup(matches, true);
        },
      };
    }

    if (ignorePreferences && topVisiblePageSuppressed && topVisibleMatch) {
      const scope =
        topVisibleMatch._type === "ProductLine"
          ? "product"
          : topVisibleMatch._type.toLowerCase();
      return {
        label: `Show this ${scope}`,
        run: async () => {
          await unsuppressPageName(topVisiblePageName);
          void renderInlinePopup(matches, true);
        },
      };
    }

    return {
      label: undefined,
      run: async () => {
        if (!topVisiblePageName) return;
        await suppressPageName(topVisiblePageName);
        void renderInlinePopup(matches, ignorePreferences);
      },
    };
  };

  const suppressPageNameAction = getSuppressPageNameAction();

  const handleSuppressSiteClick = async () => {
    if (ignorePreferences && currentlySuppressed) {
      await unsuppressCurrentSite();
      void renderInlinePopup(matches, true);
      return;
    }

    await suppressCurrentSite();
    removeInlinePopup();
  };

  const onCloseHandler = () => {
    console.log(`${Constants.LOG_PREFIX} InlinePopup onClose invoked`);
    removeInlinePopup();
  };
  componentCloseHandler = onCloseHandler;

  root.render(
    <InlinePopup
      matches={visibleMatches}
      logoUrl={ASSET_URLS.logo}
      externalIconUrl={ASSET_URLS.external}
      settingsIconUrl={ASSET_URLS.settings}
      closeIconUrl={ASSET_URLS.close}
      onClose={onCloseHandler}
      onOpenSettings={openOptions}
      onDisableWarnings={() => void handleDisableWarnings()}
      disableWarningsLabel={
        ignorePreferences && !currentlyWarningsEnabled
          ? "Show this for all sites"
          : "Don't show me this again"
      }
      suppressButtonLabel={
        ignorePreferences && currentlySuppressed
          ? "Show this site"
          : "Hide for this site"
      }
      suppressPageNameLabel={suppressPageNameAction.label}
      onSuppressPageName={() => void suppressPageNameAction.run()}
      onSuppressSite={() => void handleSuppressSiteClick()}
    />,
  );
  startCloseTimer();
};

const runContentScript = async () => {
  console.log(`${Constants.LOG_PREFIX} runContentScript starting for ${location.href}`);
  if (!(await isWarningsEnabled()) || (await isCurrentSiteSuppressed())) {
    console.log(`${Constants.LOG_PREFIX} Not showing popup due to prefs or suppression`);
    removeInlinePopup();
  }

  const getMetaContent = (selector: string): string => {
    return (
      document.querySelector(selector)?.getAttribute("content") || ""
    ).trim();
  };

  const description = getMetaContent('meta[name="description"]');
  const metaTitle = getMetaContent('meta[name="title"]');
  const ogTitle = getMetaContent('meta[property="og:title"]');
  const ogDescription = getMetaContent('meta[property="og:description"]');
  const amazonMarketplaceProperties = extractAmazonMarketplaceProperties(
    document,
    location.hostname,
  );
  const ebayJsonLdMarketplaceProperties = extractEbayJsonLdProductProperties(
    document,
    location.hostname,
  );
  const marketplaceProperties =
    amazonMarketplaceProperties || ebayJsonLdMarketplaceProperties
      ? {
        ...(amazonMarketplaceProperties || {}),
        ...(ebayJsonLdMarketplaceProperties || {}),
      }
      : undefined;

  const context: PageContext = {
    url: location.href,
    hostname: location.hostname.toLowerCase(),
    title: (document.title || "").trim(),
    meta: {
      title: metaTitle,
      description,
      "og:title": ogTitle,
      "og:description": ogDescription,
    },
    marketplaceProperties,
  };
  console.log(`${Constants.LOG_PREFIX} Sending PAGE_CONTEXT_UPDATE`, context);
  browser.runtime.sendMessage(
    Messaging.createMessage(
      MessageType.PAGE_CONTEXT_UPDATE,
      "content",
      context,
    ),
  );
};

const handleInlinePopupInstruction = async (
  instruction: InlinePopupInstruction,
) => {
  console.log(
    `${Constants.LOG_PREFIX} Received inline popup instruction: ignorePreferences=${instruction.ignorePreferences} matches=${instruction.matches.length}`,
    instruction,
  );

  if (!instruction.ignorePreferences) {
    if (forcePopupVisible && !(await isWarningsEnabled())) {
      console.log(`${Constants.LOG_PREFIX} forcePopupVisible set but warnings disabled - skipping render`);
      return;
    }
    void renderInlinePopup(instruction.matches, false);
    return;
  }

  void renderInlinePopup(instruction.matches, true);
};

browser.runtime.onMessage.addListener((msg: unknown) => {
  const instruction = getInlinePopupInstruction(msg);
  if (!instruction) return;
  void handleInlinePopupInstruction(instruction);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  const syncPopupStateWithStorage = async () => {
    if (
      changes[Constants.STORAGE.WARNINGS_ENABLED] &&
      !(await isWarningsEnabled())
    ) {
      removeInlinePopup();
      return;
    }
    if (
      changes[Constants.STORAGE.SUPPRESSED_DOMAINS] &&
      (await isCurrentSiteSuppressed())
    ) {
      removeInlinePopup();
    }
    if (changes[Constants.STORAGE.SUPPRESSED_PAGE_NAMES]) {
      void runContentScript();
    }
  };

  void syncPopupStateWithStorage();
});

void runContentScript();
