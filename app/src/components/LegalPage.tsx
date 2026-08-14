import type { ComponentPropsWithoutRef } from "react";
import { Link } from "@tanstack/react-router";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import { useAuth } from "@/lib/auth/auth-context";
import { BrandIcon, BrandWordmark } from "@/components/Brand";

// Maps markdown structure to the app's existing Tailwind design tokens, so
// every legal page (terms/privacy/disclaimer) gets identical, on-brand
// typography without a @tailwindcss/typography dependency. The blockquote
// styling reuses the same amber/warning treatment as OptionsDisclaimer and
// MarginExplainer so "draft status" callouts read as the same kind of
// warning the rest of the app already uses.
const markdownComponents: Components = {
  h1: (props) => <h1 className="text-3xl font-bold tracking-tight text-foreground" {...props} />,
  h2: (props) => (
    <h2
      className="mt-10 border-t border-border pt-8 text-xl font-semibold tracking-tight text-foreground first:mt-6 first:border-0 first:pt-0"
      {...props}
    />
  ),
  h3: (props) => <h3 className="mt-6 text-base font-semibold text-foreground" {...props} />,
  p: (props) => <p className="mt-4 leading-relaxed text-muted-foreground" {...props} />,
  strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
  a: (props: ComponentPropsWithoutRef<"a">) => (
    <a
      className="text-[color:var(--color-primary)] underline underline-offset-2 hover:opacity-80"
      target={props.href?.startsWith("http") ? "_blank" : undefined}
      rel={props.href?.startsWith("http") ? "noopener noreferrer" : undefined}
      {...props}
    />
  ),
  ul: (props) => <ul className="mt-4 list-disc space-y-1.5 pl-5 text-muted-foreground" {...props} />,
  ol: (props) => <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-muted-foreground" {...props} />,
  li: (props) => <li className="leading-relaxed" {...props} />,
  hr: () => <hr className="my-8 border-border" />,
  blockquote: (props) => (
    <blockquote
      className="mt-6 rounded-lg border border-[color:var(--color-warning,#b45309)]/40 bg-[color:var(--color-warning,#b45309)]/10 px-4 py-3 text-sm text-foreground [&_p]:mt-0 [&_p]:text-foreground"
      {...props}
    />
  ),
  table: (props) => (
    <div className="mt-4 w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[480px] text-left text-sm" {...props} />
    </div>
  ),
  thead: (props) => <thead className="border-b border-border bg-surface text-xs uppercase tracking-wider text-muted-foreground" {...props} />,
  th: (props) => <th className="px-3 py-2 font-medium" {...props} />,
  td: (props) => <td className="border-t border-border/60 px-3 py-2 align-top text-muted-foreground" {...props} />,
  code: (props) => <code className="rounded bg-surface-2 px-1 py-0.5 text-xs" {...props} />,
};

export function LegalPage({ content }: { content: string }) {
  const { session } = useAuth();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/" className="flex items-center gap-2">
            <BrandIcon size={32} />
            <BrandWordmark />
          </Link>
          <div className="flex items-center gap-2">
            {session ? (
              <Link to="/app/dashboard">
                <Button size="sm">Go to dashboard</Button>
              </Link>
            ) : (
              <>
                <Link to="/auth" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">
                  Sign in
                </Link>
                <Link to="/auth">
                  <Button size="sm">Get started</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      </main>

      <SiteFooter />
    </div>
  );
}
