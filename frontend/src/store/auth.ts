import { create } from "zustand";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  capital?: number;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setSession: (token: string, user: AuthUser) => void;
  clear: () => void;
}

const initialToken = typeof window !== "undefined" ? localStorage.getItem("qti.token") : null;
const initialUserRaw = typeof window !== "undefined" ? localStorage.getItem("qti.user") : null;
const initialUser = initialUserRaw ? (JSON.parse(initialUserRaw) as AuthUser) : null;

export const useAuth = create<AuthState>((set) => ({
  token: initialToken,
  user: initialUser,
  setSession: (token, user) => {
    localStorage.setItem("qti.token", token);
    localStorage.setItem("qti.user", JSON.stringify(user));
    set({ token, user });
  },
  clear: () => {
    localStorage.removeItem("qti.token");
    localStorage.removeItem("qti.user");
    set({ token: null, user: null });
  },
}));
