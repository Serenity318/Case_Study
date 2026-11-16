import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { NavLinks, type NavItem } from "./nav-links";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "taxPOD CRM",
  description: "CRM with a Malaysian tax Q&A assistant",
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/leads", label: "Leads" },
  { href: "/opportunities", label: "Opportunities" },
  { href: "/ask", label: "Tax Q&A" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-zinc-200 dark:border-zinc-800">
          <nav className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-1 px-4 py-2 sm:px-6">
            <Link href="/" className="mr-4 text-sm font-semibold">
              taxPOD CRM
            </Link>
            {/* usePathname can suspend under cacheComponents on routes with unknown dynamic
                params; the fallback renders the same links without the active highlight. */}
            <Suspense
              fallback={NAV_ITEMS.map((item) => (
                <Link key={item.href} href={item.href} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400">
                  {item.label}
                </Link>
              ))}
            >
              <NavLinks items={NAV_ITEMS} />
            </Suspense>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
