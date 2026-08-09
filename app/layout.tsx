import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "声图 · 朗诵情感图谱";
const description = "把优秀朗诵变成看得懂、听得到、可以反复学习的互动朗诵谱。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const socialImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: new URL(origin),
    title: {
      default: title,
      template: "%s · 声图",
    },
    description,
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title,
      description,
      images: [
        {
          url: socialImage,
          width: 1730,
          height: 910,
          alt: "声图 · 朗诵情感图谱",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
