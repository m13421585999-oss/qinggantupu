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
    icons: {
      icon: "/og.png",
      apple: "/og.png",
    },
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
      <body>
        <div className="mobile-portrait-gate" role="status" aria-live="polite">
          <div className="mobile-portrait-gate-card">
            <span className="mobile-portrait-brand" aria-hidden="true">声</span>
            <span className="mobile-rotate-device" aria-hidden="true">
              <span />
            </span>
            <p className="eyebrow">横屏观看</p>
            <strong>请将手机旋转至横屏</strong>
            <p>横屏后将使用与电脑端一致的完整朗诵图谱。</p>
          </div>
        </div>
        <div className="app-orientation-shell">{children}</div>
      </body>
    </html>
  );
}
