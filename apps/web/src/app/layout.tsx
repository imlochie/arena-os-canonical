import type { Metadata } from "next";
import { ArenaShell } from "@/components/arena/ArenaShell";
import "./arena.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Arena OS — personal AI hub",
  description: "A private personal AI hub for models, assistants, workforce, projects, memory, artifacts, and specialised rooms.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><ArenaShell>{children}</ArenaShell></body></html>;
}
