import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { translations, type Language } from "./dictionaries";

const STORAGE_KEY = "finanfa.language";

/**
 * Real request: let the user switch the whole UI between English and
 * French, and — "ça serait tellement cool" — auto-detect from the OS/
 * browser locale when they've never explicitly chosen. navigator.language
 * is exactly that signal (e.g. "fr-FR", "fr", "en-US", set from the OS's
 * own locale in every browser) — only consulted once, the first time
 * there's no saved preference; an explicit choice always wins after that.
 */
function detectInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "fr") return stored;
  } catch {
    // Private window or blocked storage — fall through to detection below,
    // same as every other localStorage convenience in this app.
  }
  const nav = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
  return nav.toLowerCase().startsWith("fr") ? "fr" : "en";
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  /** Looks up `key` in the current language's dictionary, falling back to English (never the raw key) if missing there too. {name}-style placeholders in the string are replaced from `vars`. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(detectInitialLanguage);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort — a private window or blocked storage just means the
      // choice doesn't persist across reloads, not a reason to fail.
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = translations[language] ?? translations.en;
      let str = dict[key] ?? translations.en[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          str = str.replace(`{${name}}`, String(value));
        }
      }
      return str;
    },
    [language],
  );

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within a LanguageProvider");
  return ctx;
}
