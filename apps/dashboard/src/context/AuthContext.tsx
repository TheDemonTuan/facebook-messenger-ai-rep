import React, { createContext, useContext, useEffect, useState } from "react";
import type { SessionUser } from "../types";
import { fetchCurrentUser, loginWithCloudflare, logoutUser } from "../api";

interface AuthContextType {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  login: (devEmail?: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refreshUser = async () => {
    try {
      setError(null);
      const currentUser = await fetchCurrentUser();
      setUser(currentUser);
    } catch (err) {
      setUser(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  const login = async (devEmail?: string): Promise<SessionUser> => {
    setLoading(true);
    setError(null);
    try {
      const u = await loginWithCloudflare(devEmail);
      setUser(u);
      return u;
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await logoutUser();
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, error, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
