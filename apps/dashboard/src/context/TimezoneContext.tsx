import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  getGlobalBusinessTimeZone,
  setGlobalBusinessTimeZone,
  subscribeToTimeZoneChange,
  formatFriendlyTimeZone,
  formatDateTime as helperFormatDateTime,
  formatTime as helperFormatTime,
  formatDate as helperFormatDate,
} from "../helpers/date-helpers";

interface TimezoneContextType {
  timeZone: string;
  setTimeZone: (tz: string) => void;
  friendlyIndicator: string;
  formatDateTime: (date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string;
  formatTime: (date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string;
  formatDate: (date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string;
}

const TimezoneContext = createContext<TimezoneContextType | undefined>(undefined);

export const TimezoneProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [timeZone, setLocalTimeZone] = useState<string>(getGlobalBusinessTimeZone);

  useEffect(() => {
    return subscribeToTimeZoneChange((newTz) => {
      setLocalTimeZone(newTz);
    });
  }, []);

  const setTimeZone = useCallback((newTz: string) => {
    const updated = setGlobalBusinessTimeZone(newTz);
    setLocalTimeZone(updated);
  }, []);

  const formatDateTime = useCallback(
    (date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) =>
      helperFormatDateTime(date, timeZone, options),
    [timeZone]
  );

  const formatTime = useCallback(
    (date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) =>
      helperFormatTime(date, timeZone, options),
    [timeZone]
  );

  const formatDate = useCallback(
    (date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) =>
      helperFormatDate(date, timeZone, options),
    [timeZone]
  );

  const friendlyIndicator = formatFriendlyTimeZone(timeZone);

  return (
    <TimezoneContext.Provider
      value={{
        timeZone,
        setTimeZone,
        friendlyIndicator,
        formatDateTime,
        formatTime,
        formatDate,
      }}
    >
      {children}
    </TimezoneContext.Provider>
  );
};

export function useBusinessTimeZone(): TimezoneContextType {
  const context = useContext(TimezoneContext);
  if (!context) {
    // Graceful fallback for components or tests outside Provider
    const currentTz = getGlobalBusinessTimeZone();
    return {
      timeZone: currentTz,
      setTimeZone: setGlobalBusinessTimeZone,
      friendlyIndicator: formatFriendlyTimeZone(currentTz),
      formatDateTime: (d, opt) => helperFormatDateTime(d, currentTz, opt),
      formatTime: (d, opt) => helperFormatTime(d, currentTz, opt),
      formatDate: (d, opt) => helperFormatDate(d, currentTz, opt),
    };
  }
  return context;
}
