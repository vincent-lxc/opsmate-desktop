import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enUS from "../locales/en-US";
import zhCN from "../locales/zh-CN";

export const LOCALE_STORAGE_KEY = "opsmate-locale";
export const SUPPORTED_LOCALES = ["en-US", "zh-CN"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

function readStoredLocale(): AppLocale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "en-US" || stored === "zh-CN") return stored;
  const browser = navigator.language;
  return browser.startsWith("zh") ? "zh-CN" : "en-US";
}

void i18n.use(initReactI18next).init({
  resources: {
    "en-US": { translation: enUS },
    "zh-CN": { translation: zhCN },
  },
  lng: readStoredLocale(),
  fallbackLng: "en-US",
  interpolation: { escapeValue: false },
});

export default i18n;