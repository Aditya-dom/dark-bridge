import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
    title: "Privacy Bridge - Inco",
    description: "Cross-chain privacy bridge powered by Inco TEE",
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body className="min-h-screen bg-neutral-950 text-neutral-100">
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
