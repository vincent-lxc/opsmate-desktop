import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { ProConfigProvider } from "@ant-design/pro-components";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import "dayjs/locale/en";
import "dayjs/locale/zh-cn";

dayjs.extend(localizedFormat);
import i18n, { LOCALE_STORAGE_KEY, type AppLocale } from "../i18n";
import { formatDate, formatDateTime } from "../utils/datetime";
import { EntitlementsProvider } from "./EntitlementsProvider";

/** ProTable valueType date/dateTime → browser locale formatting (read mode). */
const proDateValueTypeMap = {
  date: {
    render: (text: unknown) => (
      <span>{formatDate(text as string | number | Date | null | undefined)}</span>
    ),
  },
  dateTime: {
    render: (text: unknown) => (
      <span>{formatDateTime(text as string | number | Date | null | undefined)}</span>
    ),
  },
};

type AppSettings = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  isDark: boolean;
  setIsDark: (isDark: boolean) => void;
};

const THEME_STORAGE_KEY = "opsmate-theme";

const AppSettingsContext = createContext<AppSettings | null>(null);

function readStoredTheme(): boolean {
  return localStorage.getItem(THEME_STORAGE_KEY) === "dark";
}

type AppProviderProps = {
  children: ReactNode;
};

export function AppProvider({ children }: AppProviderProps) {
  const [locale, setLocaleState] = useState<AppLocale>(
    () => (i18n.language as AppLocale) || "en-US",
  );
  const [isDark, setIsDarkState] = useState(readStoredTheme);

  const setLocale = useCallback((next: AppLocale) => {
    void i18n.changeLanguage(next);
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
    setLocaleState(next);
  }, []);

  const setIsDark = useCallback((next: boolean) => {
    localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
    setIsDarkState(next);
  }, []);

  useEffect(() => {
    const onLanguageChanged = (lng: string) => {
      if (lng === "en-US" || lng === "zh-CN") {
        setLocaleState(lng);
      }
    };
    i18n.on("languageChanged", onLanguageChanged);
    return () => {
      i18n.off("languageChanged", onLanguageChanged);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
    document.title =
      locale === "zh-CN" ? "OpsMate 运维助手" : "OpsMate Admin";
    dayjs.locale(locale === "zh-CN" ? "zh-cn" : "en");
  }, [locale]);

  const antdLocale = locale === "zh-CN" ? zhCN : enUS;

  const value = useMemo(
    () => ({ locale, setLocale, isDark, setIsDark }),
    [locale, setLocale, isDark, setIsDark],
  );

  return (
    <AppSettingsContext.Provider value={value}>
      <ConfigProvider
        locale={antdLocale}
        theme={{
          algorithm: isDark
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm,
        }}
      >
        <ProConfigProvider valueTypeMap={proDateValueTypeMap}>
          <EntitlementsProvider>{children}</EntitlementsProvider>
        </ProConfigProvider>
      </ConfigProvider>
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings(): AppSettings {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) {
    throw new Error("useAppSettings must be used within AppProvider");
  }
  return ctx;
}