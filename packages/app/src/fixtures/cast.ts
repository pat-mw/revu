import type { GhUser, Human } from '@revu/shared'
/**
 * The cast. Contractors exist only broker-side (no GitHub accounts in the
 * client's org). Org members are real GitHub users who review on github.com.
 */

export const REPO = {
  full_name: 'meridian-labs/atlas',
  default_branch: 'main',
} as const

export const HUMANS: Human[] = [
  {
    id: 'h-priya',
    name: 'Priya Raman',
    role: 'contractor',
    email: 'priya.raman@acme.dev',
  },
  {
    id: 'h-alice',
    name: 'Alice Nguyen',
    role: 'contractor',
    email: 'alice.nguyen@acme.dev',
  },
  {
    id: 'h-marcus',
    name: 'Marcus Webb',
    role: 'contractor',
    email: 'marcus.webb@acme.dev',
  },
  {
    // Display name is a Coder username carrying a digit — the broker stamps it
    // verbatim, so this seat pins that a digit-in-username prefix still parses
    // back to a human instead of collapsing to the bare bot.
    id: 'h-alice2',
    name: 'alice2',
    role: 'contractor',
    email: 'alice.tan@acme.dev',
  },
]

export const DEFAULT_HUMAN_ID = 'h-priya'

export const BROKER_BOT: GhUser = {
  login: 'meridian-review-bot[bot]',
  id: 9000001,
  node_id: 'BOT_kgDOACmVoQ',
  avatar_url: '',
  html_url: 'https://github.com/apps/meridian-review-bot',
  type: 'Bot',
}

/** Client-side tech lead — reviews from github.com with a real account. */
export const ORG_DKOZLOV: GhUser = {
  login: 'dkozlov',
  id: 4411023,
  node_id: 'U_kgDOAEMkjw',
  avatar_url: '',
  html_url: 'https://github.com/dkozlov',
  type: 'User',
}

/** Client-side platform engineer; opens PRs revu users can actually approve. */
export const ORG_JFERRIS: GhUser = {
  login: 'jferris-ml',
  id: 5520871,
  node_id: 'U_kgDOAFQ7Zw',
  avatar_url: '',
  html_url: 'https://github.com/jferris-ml',
  type: 'User',
}

export const ORG_MEMBERS: GhUser[] = [ORG_DKOZLOV, ORG_JFERRIS]
