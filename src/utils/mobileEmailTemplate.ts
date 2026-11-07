/**
 * Presenti Mobile Email Template Generator
 * Follows ArtCraft Design System (Navy #142748, Accent Blue #2d81ff, Warm Paper #f2f1ee, 0px border-radius)
 */

export function renderMobileVerificationEmail(
  code: string,
  purpose: 'SIGNUP' | 'RESET_PASSWORD',
  recipientEmail?: string
): string {
  const isSignup = purpose === 'SIGNUP';

  if (isSignup) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Presenti — Verify Your Mobile Account</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f2f1ee; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #142748; }
    .wrapper { width: 100%; background-color: #f2f1ee; padding: 48px 16px; }
    .card { max-width: 560px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; }
    .header-bar { background-color: #142748; padding: 24px 36px; border-bottom: 2px solid #2d81ff; }
    .brand-title { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 700; color: #f2f1ee; letter-spacing: 0.12em; text-transform: uppercase; margin: 0; }
    .content { padding: 40px 36px; }
    .badge { display: inline-block; padding: 5px 10px; background-color: rgba(45, 129, 255, 0.08); border: 1px solid rgba(45, 129, 255, 0.25); font-family: ui-monospace, monospace; font-size: 10px; font-weight: 700; color: #2d81ff; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 18px; }
    h1 { font-size: 26px; font-weight: 700; color: #142748; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.65; color: #142748; margin: 0 0 20px 0; }
    .code-box { background-color: #f2f1ee; border: 1.5px solid #142748; padding: 24px; text-align: center; margin: 28px 0; }
    .code-title { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 700; color: #64748b; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 12px; }
    .code-digits { font-family: ui-monospace, monospace; font-size: 40px; font-weight: 800; letter-spacing: 10px; color: #142748; }
    .code-expiry { font-size: 12px; color: #64748b; margin-top: 10px; }
    .footer { background-color: #fafaf9; border-top: 1px solid #e5e7eb; padding: 24px 36px; font-size: 11.5px; color: #94a3b8; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="wrapper">
    <table role="presentation" class="card" width="100%" align="center">
      <tr><td class="header-bar"><span class="brand-title">PRESENTI • MOBILE WORKFORCE</span></td></tr>
      <tr>
        <td class="content">
          <div class="badge">MOBILE VERIFICATION</div>
          <h1>Verify Your Email Address</h1>
          <p>Welcome to Presenti! To complete your registration on the mobile app, enter the 6-digit verification code below:</p>
          <div class="code-box">
            <div class="code-title">VERIFICATION CODE</div>
            <div class="code-digits">${code}</div>
            <div class="code-expiry">Valid for 10 minutes • Do not share this code</div>
          </div>
          <p style="font-size: 13.5px; color: #64748b;">If you did not request this account registration, you can safely ignore this email.</p>
        </td>
      </tr>
      <tr>
        <td class="footer">
          <strong>Presenti Workforce Ecosystem</strong><br>
          Zero-Proxy Biometric Verification &amp; Physical Presence Anchors<br>
          ${recipientEmail ? `Dispatched to <code>${recipientEmail}</code>.<br>` : ''}
          &copy; ${new Date().getFullYear()} Presenti Platform • All rights reserved.
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
  }

  // Password reset template
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presenti Security — Password Reset Code</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f2f1ee; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #142748; }
    .wrapper { width: 100%; background-color: #f2f1ee; padding: 48px 16px; }
    .card { max-width: 560px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; }
    .header-bar { background-color: #142748; padding: 24px 36px; border-bottom: 2px solid #2d81ff; }
    .brand-title { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 700; color: #f2f1ee; letter-spacing: 0.12em; text-transform: uppercase; margin: 0; }
    .content { padding: 40px 36px; }
    .badge { display: inline-block; padding: 5px 10px; background-color: rgba(217, 45, 32, 0.08); border: 1px solid rgba(217, 45, 32, 0.25); font-family: ui-monospace, monospace; font-size: 10px; font-weight: 700; color: #d92d20; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 18px; }
    h1 { font-size: 26px; font-weight: 700; color: #142748; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.65; color: #142748; margin: 0 0 20px 0; }
    .code-box { background-color: #f2f1ee; border: 1.5px solid #142748; padding: 24px; text-align: center; margin: 28px 0; }
    .code-title { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 700; color: #64748b; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 12px; }
    .code-digits { font-family: ui-monospace, monospace; font-size: 40px; font-weight: 800; letter-spacing: 10px; color: #142748; }
    .code-expiry { font-size: 12px; color: #64748b; margin-top: 10px; }
    .footer { background-color: #fafaf9; border-top: 1px solid #e5e7eb; padding: 24px 36px; font-size: 11.5px; color: #94a3b8; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="wrapper">
    <table role="presentation" class="card" width="100%" align="center">
      <tr><td class="header-bar"><span class="brand-title">PRESENTI • SECURITY COMMAND</span></td></tr>
      <tr>
        <td class="content">
          <div class="badge">SECURITY • PASSWORD RESET</div>
          <h1>Reset Account Password</h1>
          <p>We received a request to reset your Presenti password on mobile. Enter the 6-digit authorization code below to set a new password:</p>
          <div class="code-box">
            <div class="code-title">AUTHORIZATION CODE</div>
            <div class="code-digits">${code}</div>
            <div class="code-expiry">Expires in 10 minutes • Single use only</div>
          </div>
          <p style="font-size: 13.5px; color: #64748b;">If you did not request this code, you can safely disregard this email.</p>
        </td>
      </tr>
      <tr>
        <td class="footer">
          <strong>Presenti Workforce Ecosystem</strong><br>
          Zero-Proxy Biometric Verification &amp; Physical Presence Anchors<br>
          ${recipientEmail ? `Dispatched to <code>${recipientEmail}</code>.<br>` : ''}
          &copy; ${new Date().getFullYear()} Presenti Platform • All rights reserved.
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

export function renderMobileWelcomeEmail(
  name: string,
  role: 'ADMIN' | 'WORKER',
  recipientEmail?: string
): string {
  const isAdmin = role === 'ADMIN';
  const displayName = name?.trim() || (isAdmin ? 'Administrator' : 'Workforce Member');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Presenti — ${isAdmin ? 'Administrator Workspace' : 'Workforce Account'} Activated</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f2f1ee; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #142748; }
    .wrapper { width: 100%; background-color: #f2f1ee; padding: 48px 16px; }
    .card { max-width: 560px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; }
    .header-bar { background-color: #142748; padding: 24px 36px; border-bottom: 2px solid #2d81ff; }
    .brand-title { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 700; color: #f2f1ee; letter-spacing: 0.12em; text-transform: uppercase; margin: 0; }
    .content { padding: 40px 36px; }
    .badge { display: inline-block; padding: 5px 10px; background-color: rgba(45, 129, 255, 0.08); border: 1px solid rgba(45, 129, 255, 0.25); font-family: ui-monospace, monospace; font-size: 10px; font-weight: 700; color: #2d81ff; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 18px; }
    h1 { font-size: 26px; font-weight: 700; color: #142748; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.65; color: #142748; margin: 0 0 20px 0; }
    .welcome-banner { background-color: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #2d81ff; padding: 18px 20px; margin: 24px 0; }
    .welcome-role { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 700; color: #2d81ff; text-transform: uppercase; margin-bottom: 4px; }
    .welcome-text { font-size: 14px; color: #334155; line-height: 1.5; margin: 0; }
    .roadmap { background-color: #fafaf9; border: 1px solid #e5e7eb; padding: 22px; margin: 28px 0; }
    .roadmap-title { font-family: ui-monospace, monospace; font-size: 10.5px; font-weight: 700; color: #64748b; letter-spacing: 0.06em; margin-bottom: 16px; }
    .step-item { display: flex; align-items: flex-start; margin-bottom: 14px; }
    .step-num { width: 22px; height: 22px; background-color: #142748; color: #ffffff; font-family: ui-monospace, monospace; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; text-align: center; line-height: 22px; }
    .step-text { font-size: 13.5px; line-height: 1.5; color: #142748; }
    .footer { background-color: #fafaf9; border-top: 1px solid #e5e7eb; padding: 24px 36px; font-size: 11.5px; color: #94a3b8; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="wrapper">
    <table role="presentation" class="card" width="100%" align="center">
      <tr><td class="header-bar"><span class="brand-title">PRESENTI • WORKFORCE COMMAND</span></td></tr>
      <tr>
        <td class="content">
          <div class="badge">${isAdmin ? 'ADMINISTRATOR WORKSPACE' : 'WORKFORCE MEMBER'}</div>
          <h1>Welcome to Presenti, ${displayName}!</h1>
          <p>
            ${
              isAdmin
                ? 'Your mobile administrator account is now active. You have full access to calibrate premises presence boundaries, review real-time presence telemetry, and oversee workforce attendance.'
                : 'Your workforce presence account has been created successfully. You are now connected to the Presenti ecosystem for verified, fraud-free on-premise attendance.'
            }
          </p>

          <div class="welcome-banner">
            <div class="welcome-role">${isAdmin ? 'ROLE: FIELD ADMINISTRATOR' : 'ROLE: WORKFORCE MEMBER'}</div>
            <div class="welcome-text">
              Signed in as <strong>${recipientEmail || 'your verified email'}</strong>. Your presence verification is backed by hardware-isolated device binding.
            </div>
          </div>

          <div class="roadmap">
            <div class="roadmap-title">${isAdmin ? 'NEXT STEPS FOR PREMISES SETUP:' : 'HOW TO RECORD ATTENDANCE:'}</div>
            ${
              isAdmin
                ? `
                <div class="step-item"><div class="step-num">1</div><div class="step-text"><strong>Calibrate Boundary:</strong> Switch to the Presence Anchors tab on mobile to pinpoint your office GPS boundary.</div></div>
                <div class="step-item"><div class="step-num">2</div><div class="step-text"><strong>Share Org Code:</strong> Provide your team with your Organization Code so they can link their devices.</div></div>
                <div class="step-item"><div class="step-num">3</div><div class="step-text"><strong>Live Presence:</strong> View live presence radar and attendance reports on your web and mobile dashboards.</div></div>
                `
                : `
                <div class="step-item"><div class="step-num">1</div><div class="step-text"><strong>Pair Organization:</strong> Enter your team's Organization Code to bind your branch.</div></div>
                <div class="step-item"><div class="step-num">2</div><div class="step-text"><strong>Bind Device:</strong> Your smartphone hardware is cryptographically bound to prevent proxy clock-ins.</div></div>
                <div class="step-item"><div class="step-num">3</div><div class="step-text"><strong>1-Tap Verification:</strong> Tap Clock In whenever you arrive within your workplace boundary.</div></div>
                `
            }
          </div>

          <p style="font-size: 13.5px; color: #64748b; margin-top: 24px; margin-bottom: 0;">
            Need help? Contact your administrator or email support@presenti.app.
          </p>
        </td>
      </tr>
      <tr>
        <td class="footer">
          <strong>Presenti Workforce Ecosystem</strong><br>
          Zero-Proxy Biometric Verification &amp; Physical Presence Anchors<br>
          ${recipientEmail ? `Dispatched to <code>${recipientEmail}</code>.<br>` : ''}
          &copy; ${new Date().getFullYear()} Presenti Platform • All rights reserved.
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

