import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Waveyard — pull music apart",
  description: "A self-hostable studio for real stem separation, remixing, and sharing.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
