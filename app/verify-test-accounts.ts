// Real DB evidence for the admin console's test-account flag (2026-08-13
// app audit, Part 5/6). Can't browser-verify with a screenshot: is_admin
// has no client OR service-role write path by design (see
// verify-admin-live.ts §1), only Venky's manual SQL sets it. Instead this
// calls the exact same isTestAccountEmail() the admin console uses,
// against the real auth.users list, mirroring verify-admin-live.ts's
// "call the real function/logic directly" pattern. This is also what
// caught the @example.com-vs-.org gap during the audit fix — worth
// re-running whenever the test-account convention or the account list
// itself could plausibly have drifted.
import { getServiceClient } from "@/lib/supabase/admin.server";
import { isTestAccountEmail } from "@/lib/admin/testAccounts";
import { step, assert, runVerification } from "./verify-harness";

async function main() {
  const admin = getServiceClient();
  const { data } = await step("list all auth users", () => admin.auth.admin.listUsers({ page: 1, perPage: 1000 }));
  const users = data!.users;

  let real = 0;
  let test = 0;
  const testEmails: string[] = [];
  const realEmails: string[] = [];
  for (const u of users) {
    if (isTestAccountEmail(u.email)) {
      test++;
      testEmails.push(u.email!);
    } else {
      real++;
      realEmails.push(u.email!);
    }
  }

  console.log(`\n  Total accounts: ${users.length}`);
  console.log(`  Real: ${real} — ${realEmails.join(", ")}`);
  console.log(`  Test (@example.org): ${test}`);
  console.log(`  Sample test emails: ${testEmails.slice(0, 3).join(", ")}${testEmails.length > 3 ? ", ..." : ""}`);

  assert("counted every account exactly once", real + test === users.length);
  assert("at least one real account found (venkatpraveen1@gmail.com)", realEmails.some((e) => e.toLowerCase() === "venkatpraveen1@gmail.com"));
  assert(
    "all test-classified emails genuinely end in @example.org/.com/.net",
    testEmails.every((e) => /@example\.(org|com|net)$/i.test(e)),
  );
  assert("no real-looking email (gmail/outlook/yahoo) misclassified as test", !testEmails.some((e) => /@(gmail|outlook|yahoo)\.com$/i.test(e)));
  assert("test accounts significantly outnumber real accounts (expected: many throwaway verify-*.ts runs)", test > real, `test=${test} real=${real}`);
}

runVerification(main);
