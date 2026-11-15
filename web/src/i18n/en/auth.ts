// Strings for sign-in, registration, invitations and installing the app.
// The first few sign-in words (auth.email, auth.signIn.title ...) are in
// i18n/en/common.ts.

export const authStrings = {
  "auth.or": "or",
  "auth.backToSignIn": "Back to sign in",
  "auth.newPassword": "New password",
  "auth.continueWith": "Continue with {name}",
  "auth.passkey.signIn": "Sign in with a passkey",
  "auth.passkey.busy": "Waiting for your passkey…",
  "auth.signIn.forgot": "Forgot your password?",
  "auth.signIn.new": "New here?",
  "auth.signIn.register": "Create an account",
  "auth.signIn.noWay":
    "Every way of signing in is turned off on this install. Whoever runs it can turn one back on from the server.",

  "auth.second.lead": "Enter the six-digit code from your authenticator app.",
  "auth.second.recoveryLead":
    "Enter one of the recovery codes you saved when you turned on two-step verification. Each works once.",
  "auth.second.code": "Code",
  "auth.second.recovery": "Recovery code",
  "auth.second.recoveryHint": "Ten letters and digits, with a dash in the middle.",
  "auth.second.submit": "Verify",
  "auth.second.busy": "Checking…",
  "auth.second.useRecovery": "Use a recovery code instead",
  "auth.second.useCode": "Use a code from your app instead",
  "auth.second.back": "Back to sign in",

  "auth.reset.title": "Reset your password",
  "auth.reset.lead": "Enter the email of your account and we will send a link to choose a new password.",
  "auth.reset.noMail": "This install has no mail server, so it cannot send a link to choose a new password.",
  "auth.reset.noMailHow": "Ask whoever runs it to reset your password. They do it on the server with:",
  "auth.reset.submit": "Send the link",
  "auth.reset.busy": "Sending…",
  "auth.reset.sentTitle": "Check your mail",
  "auth.reset.sent": "If there is an account for {email}, a link to choose a new password is on its way.",
  "auth.reset.sentHint": "The link works for one hour. If nothing arrives, check the address and your spam folder.",
  "auth.reset.another": "Use another address",
  "auth.reset.newTitle": "Choose a new password",
  "auth.reset.newLead": "Every browser signed in to your account will be signed out.",
  "auth.reset.save": "Set password",
  "auth.reset.saving": "Saving…",
  "auth.reset.done": "Your password is changed. Sign in with the new one.",
  "auth.reset.goneTitle": "This link no longer works",
  "auth.reset.again": "Ask for a new link",

  "auth.register.title": "Create an account",
  "auth.register.lead": "Make an account on {name}. You can create a workspace or join one by invitation after.",
  "auth.register.submit": "Create account",
  "auth.register.busy": "Creating…",
  "auth.register.have": "Already have an account?",
  "auth.register.closedTitle": "Registration is closed",
  "auth.register.closed":
    "People join this install by invitation. Ask someone in the workspace to invite you; the link they send lets you make an account.",

  "auth.invite.title": "Join {workspace}",
  "auth.invite.lead": "{who} invited you as {role}.",
  "auth.invite.leadNobody": "You are invited as {role}.",
  "auth.invite.signedInAs": "You are signed in as {name} ({email}).",
  "auth.invite.joinAs": "Join as {name}",
  "auth.invite.joining": "Joining…",
  "auth.invite.otherAccount": "Sign out and use another account",
  "auth.invite.createAndJoin": "Create account and join",
  "auth.invite.emailFixed": "This invitation is for this address.",
  "auth.invite.signIn": "Sign in to join",
  "auth.invite.signInToJoin": "Sign in to join",
  "auth.invite.hasAccount": "There is already an account for {email}. Sign in to it to accept the invitation.",
  "auth.invite.providerOnly": "Continue with the account below to join. Passwords are turned off on this install.",
  "auth.invite.goneTitle": "This invitation cannot be used",
  "auth.invite.toApp": "Go to your workspace",

  "auth.workspace.create": "Create workspace",
  "auth.workspace.lead": "A workspace has its own projects, members and agents. You will be its owner.",
  "auth.workspace.address": "Address",
  "auth.workspace.addressHint": "It will live at {address}",
  "auth.workspace.nameNeeded": "Give the workspace a name",
  "auth.noWorkspace.title": "You are not in a workspace yet",
  "auth.noWorkspace.lead": "Work happens in a workspace: a team's projects, people and agents.",
  "auth.noWorkspace.invite":
    "To join an existing workspace, ask someone in it for an invitation and open the link they send.",
  "auth.noWorkspace.inviteOnly":
    "Workspaces on this install are made by its admins. To join one, ask someone in it for an invitation and open the link they send.",
  "auth.noWorkspace.signedInAs": "Signed in as {email}.",

  "auth.firstRun.title": "Create your first project",
  "auth.firstRun.lead": "Tasks live in projects. Make one to start adding work; statuses and labels come with it.",
  "auth.firstRun.memberLead": "This workspace has no projects yet. An admin or owner needs to create the first one.",
  "auth.firstRun.create": "Create a project",

  "auth.admin": "Admin",

  "auth.account.title": "Two-step verification",
  "auth.account.lead": "A second step when you sign in: a code from an authenticator app, or a passkey.",
  "auth.account.back": "Back to Quadit",
  "auth.account.required":
    "This install asks everyone for a second step. Set up an authenticator app or add a passkey here; your workspaces open once one is in place.",
  "auth.account.ready": "You have a second step. Your workspaces are open.",
};
