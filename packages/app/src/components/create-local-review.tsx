import { useCallback, useEffect, useReducer } from 'react'
import { useNavigate } from 'react-router'
import { Check, GitBranch, Plus } from 'lucide-react'
import { ApiError } from '@revu/shared'
import type { BranchRef } from '@revu/shared'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { describeApiError } from '@/components/review/error-copy'
import { createReviewIssue } from '@/lib/local-reviews'
import { useBranches, useCreateLocalReview } from '@/state/local-reviews'

/**
 * Opening a review of one local branch against another — no pull request, no
 * push, nothing on GitHub.
 *
 * ## The title is chosen once, here, permanently
 *
 * The API surface for a local review is create, list and delete: there is no
 * update verb, and so no way to rename a review after it exists. Whatever is in
 * the title field when the review is created is its name for as long as it
 * lives, and the only way to change it is to delete the review — losing its
 * drafts and threads with it — and start again. That is why the field carries a
 * default worth keeping (the head branch name), sits at full width rather than
 * squeezed beside the pickers, and says so under itself. Anyone tempted to make
 * this quieter should add a rename route first.
 *
 * ## Why this file is three exports and not one component
 *
 * A dialog's body renders through a portal, which produces no server markup at
 * all — a test that rendered the dialog would be asserting against an empty
 * string and would keep passing through any regression. So the parts that carry
 * behavior are separated from the shell that cannot be observed:
 *
 * - `CreateLocalReviewForm` is the portal-free body. It owns no query and no
 *   mutation: branches, the current values, the pending flag and the error
 *   sentence all arrive as props, so its rendering is a pure function of them.
 * - `describeCreateLocalReviewError` is the single source of the failure copy.
 * - `reduceCreateLocalReview` is the state machine, pure and driveable without
 *   a renderer — which is where the promise that a failed create loses nothing
 *   the human wrote is actually kept.
 *
 * `CreateLocalReviewDialog` is then only wiring: the shell, the reducer and the
 * mutation, thin enough to read in one pass.
 */

// ————————————————————————————————————————————————————————————————
// Failure copy
// ————————————————————————————————————————————————————————————————

/**
 * One honest sentence for a create that failed, to show beside a form that is
 * still holding everything the human wrote.
 *
 * The refusals that are about the branches themselves — the two sides naming
 * one ref, histories with no merge base, a clone too shallow to find one, a
 * name git will not accept — all arrive under a single "cannot be satisfied as
 * given" code, and their sentences are NOT reconstructed here. Only the side
 * that ran git knows which ref or which pair was at fault, and it says so; a
 * sentence invented on this side could only be vaguer, and guessing the cause
 * back out of the message would break the moment that message is reworded. So
 * those pass through as written.
 *
 * The transport failures are the opposite case: the message describes a socket,
 * not this action, and the reader's real question is whether the title they
 * just typed is gone. That answer belongs here, where the form is known to be
 * still holding it.
 */
export function describeCreateLocalReviewError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'unprocessable') return error.message
    if (error.code === 'not_found') {
      return `${error.message} The branch list may be out of date — close and reopen this dialog to re-read it.`
    }
    if (error.code === 'network' || error.code === 'broker_unreachable') {
      return 'Could not reach the workspace, so no review was created. Everything you typed is still here — try again.'
    }
  }
  return describeApiError(error)
}

// ————————————————————————————————————————————————————————————————
// State machine
// ————————————————————————————————————————————————————————————————

/** Everything the create form holds between opening and landing on a review. */
export interface CreateLocalReviewState {
  /** Fully qualified base ref, or empty before one is picked. */
  base: string
  /** Fully qualified head ref, or empty before one is picked. */
  head: string
  /**
   * The human's title, or `null` while untouched — which is not the same as an
   * empty string. Untouched means the field shows, and the request sends, the
   * head branch name; emptied by hand means the human cleared it deliberately.
   */
  title: string | null
  /** The sentence to show for the last failed attempt, or `null`. */
  error: string | null
  /** A create is in flight. */
  pending: boolean
  /**
   * The review this form resolved onto, or `null` while it has none. Non-null
   * IS the finished state: the work is done and the dialog closes onto that id,
   * whether the review was minted by this attempt or already existed.
   */
  createdId: number | null
}

export type CreateLocalReviewEvent =
  /** The form was opened: start over, holding nothing from a previous visit. */
  | { type: 'reset' }
  /** A base was preselected for a form the human has not touched yet. */
  | { type: 'base_defaulted'; ref: string }
  | { type: 'base_picked'; ref: string }
  | { type: 'head_picked'; ref: string }
  | { type: 'title_edited'; title: string }
  | { type: 'create_started' }
  | { type: 'create_failed'; error: string }
  | { type: 'created'; id: number }

/** A form with nothing chosen and nothing typed. */
const EMPTY_STATE: CreateLocalReviewState = {
  base: '',
  head: '',
  title: null,
  error: null,
  pending: false,
  createdId: null,
}

/**
 * The create form's transitions.
 *
 * Two of them carry the whole design. `create_failed` rebuilds the state around
 * the previous `base`, `head` and `title` rather than starting from a fresh one:
 * a rejected request must never cost the human a title they typed, so the fields
 * survive every failure and the dialog stays open on top of them. And `created`
 * does not distinguish a review that was just minted from one that already
 * existed for the same pair — asking twice for the same two branches is a
 * success that resolves onto the review already there, never a conflict, so a
 * second attempt lands exactly where the first did.
 */
export function reduceCreateLocalReview(
  state: CreateLocalReviewState,
  event: CreateLocalReviewEvent,
): CreateLocalReviewState {
  switch (event.type) {
    case 'reset':
      return EMPTY_STATE
    case 'base_defaulted':
      // A preselection, not an override: once there is a base, the branch
      // listing arriving (or arriving again) must not move it.
      return state.base === '' ? { ...state, base: event.ref } : state
    case 'base_picked':
      return { ...state, base: event.ref }
    case 'head_picked':
      return { ...state, head: event.ref }
    case 'title_edited':
      return { ...state, title: event.title }
    case 'create_started':
      return { ...state, pending: true, error: null }
    case 'create_failed':
      return { ...state, pending: false, error: event.error }
    case 'created':
      return { ...state, pending: false, error: null, createdId: event.id }
  }
}

// ————————————————————————————————————————————————————————————————
// The form body
// ————————————————————————————————————————————————————————————————

const TITLE_FIELD_ID = 'create-local-review-title'

/** The display name a picker shows for a ref, or the ref itself if unlisted. */
function displayName(branches: readonly BranchRef[], ref: string): string {
  const listed = branches.find((branch) => branch.ref === ref)
  if (listed) return listed.name
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length)
  return ref
}

interface BranchPickerProps {
  heading: string
  /** One line saying what this side of the comparison is. */
  hint: string
  branches: readonly BranchRef[]
  /** The picked ref, or empty. */
  value: string
  onChange: (ref: string) => void
  filterLabel: string
}

/**
 * A filterable list of refs. A repository can hold hundreds of branches, so the
 * picker is a search box over a scrolling list rather than a dropdown that grows
 * without bound.
 *
 * Items are keyed and returned by fully qualified ref while the human reads the
 * short name, because those two are not interchangeable: a remote-tracking
 * `origin/main` and a local branch literally named `origin/main` share a display
 * name and are different branches. Filtering runs on the short name, which is
 * what someone is typing.
 */
function BranchPicker({
  heading,
  hint,
  branches,
  value,
  onChange,
  filterLabel,
}: BranchPickerProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="font-sans text-2xs font-medium uppercase tracking-wide text-ink-faint">
        {heading}
      </p>
      <Command label={heading} className="rounded-(--radius-sm) border border-line bg-panel">
        <CommandInput placeholder="Filter branches…" aria-label={filterLabel} />
        <CommandList className="max-h-40">
          <CommandEmpty>No branch matches.</CommandEmpty>
          <CommandGroup>
            {branches.map((branch) => {
              const picked = branch.ref === value
              return (
                <CommandItem
                  key={branch.ref}
                  value={branch.name}
                  onSelect={() => onChange(branch.ref)}
                  {...(picked ? { 'aria-current': true as const } : {})}
                >
                  <GitBranch strokeWidth={1.5} aria-hidden />
                  <span className="truncate font-mono text-xs">{branch.name}</span>
                  {picked && <Check strokeWidth={1.5} className="ml-auto text-ink" aria-hidden />}
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
      <p className="text-2xs leading-relaxed text-ink-faint">{hint}</p>
    </div>
  )
}
BranchPicker.displayName = 'BranchPicker'

export interface CreateLocalReviewFormProps {
  /** Every ref this workspace can offer, local and remote-tracking alike. */
  branches: readonly BranchRef[]
  base: string
  head: string
  /** `null` while untouched — the field then shows the head branch name. */
  title: string | null
  pending: boolean
  /** The sentence for the last failed attempt, or `null`. */
  error: string | null
  onBaseChange: (ref: string) => void
  onHeadChange: (ref: string) => void
  onTitleChange: (title: string) => void
  onCreate: () => void
}

/**
 * The create form, with no portal anywhere in it — which is what makes it
 * observable as markup, and is why the dialog's shell is somewhere else.
 *
 * The two pickers do not offer the same refs. A base is frequently a branch
 * that was never checked out (`origin/main` is an ordinary thing to compare
 * against), so the base picker offers remote-tracking refs alongside local
 * ones. A head is the work being reviewed and has to exist in this workspace,
 * so the head picker offers local branches only.
 *
 * Two kinds of message can appear under the fields and they are not the same
 * thing. A pre-flight objection — no branch chosen, both sides the same, a name
 * git would read as an option — is about what the form holds right now, so it
 * reads as guidance and holds the create action closed until it is resolved. A
 * failure sentence is about an attempt that was actually made and refused; it
 * gets the failure treatment, and it is suppressed while a pre-flight objection
 * stands, since by then it describes a request the form is no longer offering
 * to repeat.
 */
export function CreateLocalReviewForm({
  branches,
  base,
  head,
  title,
  pending,
  error,
  onBaseChange,
  onHeadChange,
  onTitleChange,
  onCreate,
}: CreateLocalReviewFormProps) {
  const headBranches = branches.filter((branch) => branch.kind === 'local')
  const headName = displayName(branches, head)
  const issue = createReviewIssue({ base, head })

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs text-ink-mut">
        {base !== '' && head !== '' ? (
          <>
            {displayName(branches, base)}
            <span className="text-ink-faint"> ← </span>
            {headName}
          </>
        ) : (
          <span className="font-sans text-ink-faint">Pick the two branches to compare.</span>
        )}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <BranchPicker
          heading="Base"
          hint="What the work is compared against. Remote-tracking branches count."
          branches={branches}
          value={base}
          onChange={onBaseChange}
          filterLabel="Filter base branches"
        />
        <BranchPicker
          heading="Head"
          hint="The work under review. Local branches only."
          branches={headBranches}
          value={head}
          onChange={onHeadChange}
          filterLabel="Filter head branches"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor={TITLE_FIELD_ID}
          className="font-sans text-2xs font-medium uppercase tracking-wide text-ink-faint"
        >
          Title
        </label>
        <Input
          id={TITLE_FIELD_ID}
          value={title ?? headName}
          onChange={(e) => onTitleChange(e.target.value)}
          // Cleared by hand, the head branch name is what gets stored — so the
          // placeholder previews the title rather than describing the field.
          placeholder={headName === '' ? 'The head branch name' : headName}
        />
        <p className="text-2xs leading-relaxed text-ink-faint">
          Set once. A local review cannot be renamed later — only deleted and remade, which
          discards its drafts and threads.
        </p>
      </div>

      {issue !== null && <p className="text-xs leading-relaxed text-ink-mut">{issue}</p>}
      {issue === null && error !== null && (
        <ErrorState title="Couldn’t create the review" detail={error} />
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="primary" onClick={onCreate} disabled={pending || issue !== null}>
          {pending ? (
            <Spinner size={12} label="Creating the review" />
          ) : (
            <Plus strokeWidth={1.5} aria-hidden />
          )}
          {pending ? 'Creating…' : 'Create review'}
        </Button>
      </div>
    </div>
  )
}
CreateLocalReviewForm.displayName = 'CreateLocalReviewForm'

// ————————————————————————————————————————————————————————————————
// The dialog
// ————————————————————————————————————————————————————————————————

export interface CreateLocalReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The create form in a modal, with the branch listing and the create mutation
 * attached.
 *
 * The branch listing is read only while the dialog is open and is re-read every
 * time it opens: branches are made, renamed and deleted under the human
 * constantly, and a picker offering a listing from an hour ago is worse than
 * one that pauses briefly.
 *
 * Navigation waits on the mutation, which does not resolve until the pull list
 * carries the new review. Going to it any earlier lands on the screen that says
 * the review is not in this installation, because that page resolves a review
 * out of the same list.
 */
export function CreateLocalReviewDialog({ open, onOpenChange }: CreateLocalReviewDialogProps) {
  const navigate = useNavigate()
  const branches = useBranches({ enabled: open })
  const create = useCreateLocalReview()
  const [state, dispatch] = useReducer(reduceCreateLocalReview, EMPTY_STATE)

  const defaultBase = branches.data?.find((branch) => branch.isDefault)?.ref ?? ''

  useEffect(() => {
    if (open) dispatch({ type: 'reset' })
  }, [open])

  useEffect(() => {
    if (!open || defaultBase === '') return
    dispatch({ type: 'base_defaulted', ref: defaultBase })
  }, [open, defaultBase])

  const submit = useCallback(async () => {
    dispatch({ type: 'create_started' })
    const typed = state.title?.trim() ?? ''
    try {
      const review = await create.mutateAsync({
        baseRef: state.base,
        headRef: state.head,
        ...(typed === '' ? {} : { title: typed }),
      })
      dispatch({ type: 'created', id: review.id })
      onOpenChange(false)
      navigate(`/pr/${review.id}`)
    } catch (err) {
      dispatch({ type: 'create_failed', error: describeCreateLocalReviewError(err) })
    }
  }, [create, navigate, onOpenChange, state.base, state.head, state.title])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review a branch</DialogTitle>
          <DialogDescription>
            Compare two branches in this workspace. Nothing is pushed and no pull request is
            opened.
          </DialogDescription>
        </DialogHeader>
        <CreateLocalReviewForm
          branches={branches.data ?? []}
          base={state.base}
          head={state.head}
          title={state.title}
          pending={state.pending}
          error={state.error}
          onBaseChange={(ref) => dispatch({ type: 'base_picked', ref })}
          onHeadChange={(ref) => dispatch({ type: 'head_picked', ref })}
          onTitleChange={(title) => dispatch({ type: 'title_edited', title })}
          onCreate={() => void submit()}
        />
      </DialogContent>
    </Dialog>
  )
}
CreateLocalReviewDialog.displayName = 'CreateLocalReviewDialog'
