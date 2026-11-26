import type { Metadata, Viewport } from "next";
import ConfirmDialog from "@/components/confirm-dialog";
import "./globals.css";

export const metadata: Metadata = {
  title: "Innofemme · Mobile Money Fraud Hackathon",
  description: "Innofemme Mobile Money Fraud Hackathon sandbox: Ghana's mobile money system, built from the ground up.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f172a" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <ConfirmDialog />
      </body>
    </html>
  );
}
