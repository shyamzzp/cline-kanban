import { Draggable } from "@hello-pangea/dnd";
import { formatClineToolCallLabel } from "@runtime-cline-tool-call-display";
import { buildTaskWorktreeDisplayPath } from "@runtime-task-worktree-path";
import { AlertCircle, GitBranch, Play, RotateCcw, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useHomeRepositoryUrlValue, useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { BoardCard as BoardCardModel, BoardColumnId, ReviewTaskWorkspaceSnapshot } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import { formatPathForDisplay } from "@/utils/path-display";
import { useInterval, useMeasure } from "@/utils/react-use";
import { formatSessionElapsedDuration } from "@/utils/session-timer";
import {
	clampTextWithInlineSuffix,
	splitPromptToTitleDescriptionByWidth,
	truncateTaskPromptLabel,
} from "@/utils/task-prompt";
import { DEFAULT_TEXT_MEASURE_FONT, measureTextWidth, readElementFontShorthand } from "@/utils/text-measure";

interface CardSessionActivity {
	dotColor: string;
	text: string;
}

type CardStatusTagTone = "neutral" | "success" | "warning" | "danger" | "muted";

interface CardStatusTag {
	key: string;
	label: string;
	tone: CardStatusTagTone;
	href?: string;
}

const SESSION_ACTIVITY_COLOR = {
	thinking: "var(--color-status-blue)",
	success: "var(--color-status-green)",
	waiting: "var(--color-status-gold)",
	error: "var(--color-status-red)",
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

const DESCRIPTION_COLLAPSE_LINES = 3;
const SESSION_PREVIEW_COLLAPSE_LINES = 6;
const DESCRIPTION_EXPAND_LABEL = "See more";
const DESCRIPTION_COLLAPSE_LABEL = "Less";
const DESCRIPTION_COLLAPSE_SUFFIX = `… ${DESCRIPTION_EXPAND_LABEL}`;
const COMPLETED_CARD_STATUS_TAG_CLASS_BY_TONE: Record<CardStatusTagTone, string> = {
	neutral: "border-border text-text-secondary bg-surface-1",
	success: "border-status-green/30 text-status-green bg-status-green/10",
	warning: "border-status-gold/35 text-status-gold bg-status-gold/10",
	danger: "border-status-red/30 text-status-red bg-status-red/10",
	muted: "border-border text-text-tertiary bg-surface-1",
};

function reconstructTaskWorktreeDisplayPath(taskId: string, workspacePath: string | null | undefined): string | null {
	if (!workspacePath) {
		return null;
	}
	try {
		return buildTaskWorktreeDisplayPath(taskId, workspacePath);
	} catch {
		return null;
	}
}

function extractToolInputSummaryFromActivityText(activityText: string, toolName: string): string | null {
	const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = activityText.match(
		new RegExp(`^(?:Using|Completed|Failed|Calling)\\s+${escapedToolName}(?::\\s*(.+))?$`),
	);
	if (!match) {
		return null;
	}
	const rawSummary = match[1]?.trim() ?? "";
	if (!rawSummary) {
		return null;
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return operationSummary?.trim() || null;
	}
	return rawSummary;
}

function parseToolCallFromActivityText(
	activityText: string,
): { toolName: string; toolInputSummary: string | null } | null {
	const match = activityText.match(/^(?:Using|Completed|Failed|Calling)\s+([^:()]+?)(?::\s*(.+))?$/);
	if (!match?.[1]) {
		return null;
	}
	const toolName = match[1].trim();
	if (!toolName) {
		return null;
	}
	const rawSummary = match[2]?.trim() ?? "";
	if (!rawSummary) {
		return { toolName, toolInputSummary: null };
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return {
			toolName,
			toolInputSummary: operationSummary?.trim() || null,
		};
	}
	return {
		toolName,
		toolInputSummary: rawSummary,
	};
}

function resolveToolCallLabel(
	activityText: string | undefined,
	toolName: string | null,
	toolInputSummary: string | null,
): string | null {
	if (toolName) {
		return formatClineToolCallLabel(
			toolName,
			toolInputSummary ?? extractToolInputSummaryFromActivityText(activityText ?? "", toolName),
		);
	}
	if (!activityText) {
		return null;
	}
	const parsed = parseToolCallFromActivityText(activityText);
	if (!parsed) {
		return null;
	}
	return formatClineToolCallLabel(parsed.toolName, parsed.toolInputSummary);
}

function getCardSessionActivity(summary: RuntimeTaskSessionSummary | undefined): CardSessionActivity | null {
	if (!summary) {
		return null;
	}
	const hookActivity = summary.latestHookActivity;
	const activityText = hookActivity?.activityText?.trim();
	const toolName = hookActivity?.toolName?.trim() ?? null;
	const toolInputSummary = hookActivity?.toolInputSummary?.trim() ?? null;
	const finalMessage = hookActivity?.finalMessage?.trim();
	const hookEventName = hookActivity?.hookEventName?.trim() ?? null;
	if (summary.state === "awaiting_review" && finalMessage) {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: finalMessage };
	}
	if (
		finalMessage &&
		!toolName &&
		(hookEventName === "assistant_delta" || hookEventName === "agent_end" || hookEventName === "turn_start")
	) {
		return {
			dotColor: summary.state === "running" ? SESSION_ACTIVITY_COLOR.thinking : SESSION_ACTIVITY_COLOR.success,
			text: finalMessage,
		};
	}
	if (activityText) {
		let dotColor: string =
			summary.state === "failed" ? SESSION_ACTIVITY_COLOR.error : SESSION_ACTIVITY_COLOR.thinking;
		let text = activityText;
		const toolCallLabel = resolveToolCallLabel(activityText, toolName, toolInputSummary);
		if (toolCallLabel) {
			if (text.startsWith("Failed ")) {
				dotColor = SESSION_ACTIVITY_COLOR.error;
			}
			return {
				dotColor,
				text: toolCallLabel,
			};
		}
		if (text.startsWith("Final: ")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
			text = text.slice(7);
		} else if (text.startsWith("Agent: ")) {
			text = text.slice(7);
		} else if (text.startsWith("Waiting for approval")) {
			dotColor = SESSION_ACTIVITY_COLOR.waiting;
		} else if (text.startsWith("Waiting for review")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
		} else if (text.startsWith("Failed ")) {
			dotColor = SESSION_ACTIVITY_COLOR.error;
		} else if (text === "Agent active" || text === "Working on task" || text.startsWith("Resumed")) {
			return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
		}
		return { dotColor, text };
	}
	if (summary.state === "failed") {
		const failedText = finalMessage ?? activityText ?? "Task failed to start";
		return { dotColor: SESSION_ACTIVITY_COLOR.error, text: failedText };
	}
	if (summary.state === "awaiting_review") {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review" };
	}
	if (summary.state === "running") {
		return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
	}
	return null;
}

function isCardAwaitingUserInput(summary: RuntimeTaskSessionSummary | undefined): boolean {
	const activityText = summary?.latestHookActivity?.activityText?.trim() ?? "";
	return activityText.startsWith("Waiting for approval");
}

function getCompletedCardStatusTags(snapshot: ReviewTaskWorkspaceSnapshot | null | undefined): CardStatusTag[] {
	if (!snapshot) {
		return [];
	}

	const tags: CardStatusTag[] = [];
	const changedFiles = snapshot.changedFiles;
	if (changedFiles === null || changedFiles === undefined) {
		tags.push({ key: "worktree", label: "Worktree unknown", tone: "muted" });
	} else if (changedFiles === 0) {
		tags.push({ key: "worktree", label: "Worktree clean", tone: "success" });
	} else {
		tags.push({
			key: "worktree",
			label: `Worktree ${changedFiles} ${changedFiles === 1 ? "change" : "changes"}`,
			tone: "warning",
		});
	}

	if (snapshot.branch) {
		tags.push({ key: "branch", label: `Branch ${snapshot.branch}`, tone: "neutral" });
	} else if (snapshot.isDetached) {
		tags.push({ key: "branch", label: "Branch detached", tone: "warning" });
	} else {
		tags.push({ key: "branch", label: "Branch unknown", tone: "muted" });
	}

	const upstreamBranch = snapshot.upstreamBranch ?? null;
	const aheadCount = snapshot.aheadCount ?? null;
	const behindCount = snapshot.behindCount ?? null;
	if (!upstreamBranch) {
		tags.push({ key: "remote-sync", label: "Remote no-upstream", tone: "muted" });
	} else if (aheadCount === null || behindCount === null) {
		tags.push({ key: "remote-sync", label: "Remote sync unknown", tone: "muted" });
	} else if (aheadCount === 0 && behindCount === 0) {
		tags.push({ key: "remote-sync", label: "Remote synced", tone: "success" });
	} else if (aheadCount > 0 && behindCount === 0) {
		tags.push({ key: "remote-sync", label: `Remote ahead ${aheadCount}`, tone: "warning" });
	} else if (aheadCount === 0 && behindCount > 0) {
		tags.push({ key: "remote-sync", label: `Remote behind ${behindCount}`, tone: "warning" });
	} else {
		tags.push({ key: "remote-sync", label: `Remote diverged +${aheadCount}/-${behindCount}`, tone: "danger" });
	}

	const baseRefLabel = snapshot.baseRef?.trim() || "base";
	const localMergeStatus = snapshot.isMergedIntoBaseBranch;
	const remoteMergeStatus = snapshot.isMergedIntoRemoteBaseBranch;
	tags.push({
		key: "base-local",
		label:
			localMergeStatus === true
				? `${baseRefLabel} merged (local)`
				: localMergeStatus === false
					? `${baseRefLabel} not merged (local)`
					: `${baseRefLabel} merge unknown (local)`,
		tone: localMergeStatus === true ? "success" : localMergeStatus === false ? "warning" : "muted",
	});
	tags.push({
		key: "base-remote",
		label:
			remoteMergeStatus === true
				? `${baseRefLabel} merged (remote)`
				: remoteMergeStatus === false
					? `${baseRefLabel} not merged (remote)`
					: `${baseRefLabel} merge unknown (remote)`,
		tone: remoteMergeStatus === true ? "success" : remoteMergeStatus === false ? "warning" : "muted",
	});

	return tags;
}

const GITHUB_RELEASE_URL_PATTERN = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/[^\s)>"']+/gi;
const SEMVER_PATTERN = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/g;
const githubReleaseLookupCache = new Map<string, Promise<string | null>>();

function normalizeGithubReleaseUrlCandidate(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.hostname !== "github.com") {
			return null;
		}
		const path = parsed.pathname.replace(/\/+$/g, "");
		const segments = path.split("/").filter((segment) => segment.length > 0);
		if (segments.length < 4) {
			return null;
		}
		if (segments[2] !== "releases") {
			return null;
		}
		if (segments[3] !== "tag" && segments[3] !== "latest") {
			return null;
		}
		return `${parsed.origin}${path}`;
	} catch {
		return null;
	}
}

function extractGithubReleaseUrlFromText(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const matches = value.match(GITHUB_RELEASE_URL_PATTERN);
	if (!matches || matches.length === 0) {
		return null;
	}
	for (const match of matches) {
		const normalized = normalizeGithubReleaseUrlCandidate(match);
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

function findTaskReleaseUrl(sessionSummary: RuntimeTaskSessionSummary | undefined): string | null {
	if (!sessionSummary) {
		return null;
	}
	const activity = sessionSummary.latestHookActivity;
	return (
		extractGithubReleaseUrlFromText(activity?.finalMessage) ??
		extractGithubReleaseUrlFromText(activity?.activityText) ??
		extractGithubReleaseUrlFromText(activity?.toolInputSummary) ??
		extractGithubReleaseUrlFromText(sessionSummary.warningMessage)
	);
}

function extractVersionFromText(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	SEMVER_PATTERN.lastIndex = 0;
	let match = SEMVER_PATTERN.exec(value);
	while (match !== null) {
		const version = match[1]?.trim();
		if (version) {
			return version;
		}
		match = SEMVER_PATTERN.exec(value);
	}
	return null;
}

function findVersionHint(cardPrompt: string, sessionSummary: RuntimeTaskSessionSummary | undefined): string | null {
	const activity = sessionSummary?.latestHookActivity;
	return (
		extractVersionFromText(activity?.finalMessage) ??
		extractVersionFromText(activity?.activityText) ??
		extractVersionFromText(activity?.toolInputSummary) ??
		extractVersionFromText(sessionSummary?.warningMessage) ??
		extractVersionFromText(cardPrompt)
	);
}

function parseGithubRepoFromRemoteUrl(remoteUrl: string | null | undefined): { owner: string; repo: string } | null {
	if (!remoteUrl) {
		return null;
	}
	const normalized = remoteUrl.trim();
	if (!normalized) {
		return null;
	}
	const sshMatch = normalized.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
	if (sshMatch?.[1] && sshMatch[2]) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}
	try {
		const parsed = new URL(normalized);
		if (parsed.hostname !== "github.com") {
			return null;
		}
		const parts = parsed.pathname
			.replace(/\.git$/i, "")
			.split("/")
			.filter((part) => part.length > 0);
		if (parts.length < 2) {
			return null;
		}
		return { owner: parts[0] as string, repo: parts[1] as string };
	} catch {
		return null;
	}
}

async function checkGithubReleaseByTag(owner: string, repo: string, tag: string): Promise<string | null> {
	const response = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
	);
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as { html_url?: unknown };
	return typeof payload.html_url === "string" ? payload.html_url : null;
}

function getGithubReleaseUrlFromVersionHint(
	remoteUrl: string | null | undefined,
	versionHint: string | null | undefined,
): Promise<string | null> {
	const repo = parseGithubRepoFromRemoteUrl(remoteUrl);
	const version = versionHint?.trim() ?? "";
	if (!repo || !version) {
		return Promise.resolve(null);
	}
	const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;
	const candidateTags = new Set<string>([normalizedVersion, `v${normalizedVersion}`]);
	const cacheKey = `${repo.owner}/${repo.repo}:${Array.from(candidateTags).sort().join(",")}`;
	const cached = githubReleaseLookupCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	const lookup = (async () => {
		for (const tag of candidateTags) {
			const found = await checkGithubReleaseByTag(repo.owner, repo.repo, tag);
			if (found) {
				return found;
			}
		}
		return null;
	})();
	githubReleaseLookupCache.set(cacheKey, lookup);
	return lookup;
}

export function BoardCard({
	card,
	index,
	columnId,
	sessionSummary,
	selected = false,
	onClick,
	onStart,
	onMoveToTrash,
	onRestoreFromTrash,
	onCommit,
	onOpenPr,
	onCancelAutomaticAction,
	isCommitLoading = false,
	isOpenPrLoading = false,
	isMoveToTrashLoading = false,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	isDependencySource = false,
	isDependencyTarget = false,
	isDependencyLinking = false,
	workspacePath,
}: {
	card: BoardCardModel;
	index: number;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	onClick?: () => void;
	onStart?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onCommit?: (taskId: string) => void;
	onOpenPr?: (taskId: string) => void;
	onCancelAutomaticAction?: (taskId: string) => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	isMoveToTrashLoading?: boolean;
	onDependencyPointerDown?: (taskId: string, event: MouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	isDependencySource?: boolean;
	isDependencyTarget?: boolean;
	isDependencyLinking?: boolean;
	workspacePath?: string | null;
}): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const [titleContainerRef, titleRect] = useMeasure<HTMLDivElement>();
	const [descriptionContainerRef, descriptionRect] = useMeasure<HTMLDivElement>();
	const [sessionPreviewContainerRef, sessionPreviewRect] = useMeasure<HTMLDivElement>();
	const titleRef = useRef<HTMLParagraphElement | null>(null);
	const descriptionRef = useRef<HTMLParagraphElement | null>(null);
	const sessionPreviewRef = useRef<HTMLParagraphElement | null>(null);
	const [titleWidthFallback, setTitleWidthFallback] = useState(0);
	const [descriptionWidthFallback, setDescriptionWidthFallback] = useState(0);
	const [sessionPreviewWidthFallback, setSessionPreviewWidthFallback] = useState(0);
	const [titleFont, setTitleFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [descriptionFont, setDescriptionFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [sessionPreviewFont, setSessionPreviewFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
	const [isSessionPreviewExpanded, setIsSessionPreviewExpanded] = useState(false);
	const [isTrashHistoryExpanded, setIsTrashHistoryExpanded] = useState(false);
	const [verifiedReleaseUrl, setVerifiedReleaseUrl] = useState<string | null>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(card.id);
	const homeRepositoryUrl = useHomeRepositoryUrlValue();
	const isTrashCard = columnId === "trash";
	const isCardInteractive = !isTrashCard;
	const titleWidth = titleRect.width > 0 ? titleRect.width : titleWidthFallback;
	const descriptionWidth = descriptionRect.width > 0 ? descriptionRect.width : descriptionWidthFallback;
	const sessionPreviewWidth = sessionPreviewRect.width > 0 ? sessionPreviewRect.width : sessionPreviewWidthFallback;
	const displayPrompt = useMemo(() => {
		return card.prompt.trim();
	}, [card.prompt]);
	const rawSessionActivity = useMemo(() => getCardSessionActivity(sessionSummary), [sessionSummary]);
	const isAwaitingUserInput = useMemo(() => isCardAwaitingUserInput(sessionSummary), [sessionSummary]);
	const lastSessionActivityRef = useRef<CardSessionActivity | null>(null);
	const lastSessionActivityCardIdRef = useRef<string | null>(null);
	if (lastSessionActivityCardIdRef.current !== card.id) {
		lastSessionActivityCardIdRef.current = card.id;
		lastSessionActivityRef.current = null;
	}
	if (rawSessionActivity) {
		lastSessionActivityRef.current = rawSessionActivity;
	}
	const sessionActivity = rawSessionActivity ?? lastSessionActivityRef.current;
	const displayPromptSplit = useMemo(() => {
		const fallbackTitle = truncateTaskPromptLabel(card.prompt);
		if (!displayPrompt) {
			return {
				title: fallbackTitle,
				description: "",
			};
		}
		if (titleWidth <= 0) {
			return {
				title: fallbackTitle,
				description: "",
			};
		}
		const split = splitPromptToTitleDescriptionByWidth(displayPrompt, {
			maxTitleWidthPx: titleWidth,
			measureText: (value) => measureTextWidth(value, titleFont),
		});
		return {
			title: split.title || fallbackTitle,
			description: split.description,
		};
	}, [card.prompt, displayPrompt, titleFont, titleWidth]);

	useLayoutEffect(() => {
		if (titleRect.width > 0) {
			return;
		}
		const nextWidth = titleRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== titleWidthFallback) {
			setTitleWidthFallback(nextWidth);
		}
	}, [titleRect.width, titleWidthFallback]);

	useLayoutEffect(() => {
		if (descriptionRect.width > 0 || !displayPromptSplit.description) {
			return;
		}
		const nextWidth = descriptionRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== descriptionWidthFallback) {
			setDescriptionWidthFallback(nextWidth);
		}
	}, [descriptionRect.width, descriptionWidthFallback, displayPromptSplit.description]);

	useLayoutEffect(() => {
		if (sessionPreviewRect.width > 0 || !isTrashCard || !sessionActivity?.text) {
			return;
		}
		const nextWidth = sessionPreviewRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== sessionPreviewWidthFallback) {
			setSessionPreviewWidthFallback(nextWidth);
		}
	}, [isTrashCard, sessionActivity?.text, sessionPreviewRect.width, sessionPreviewWidthFallback]);

	useLayoutEffect(() => {
		setTitleFont(readElementFontShorthand(titleRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [titleWidth]);

	useLayoutEffect(() => {
		setDescriptionFont(readElementFontShorthand(descriptionRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [descriptionWidth, displayPromptSplit.description]);

	useLayoutEffect(() => {
		setSessionPreviewFont(readElementFontShorthand(sessionPreviewRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [sessionActivity?.text, sessionPreviewWidth]);

	useEffect(() => {
		setIsDescriptionExpanded(false);
	}, [card.id, displayPromptSplit.description]);

	useEffect(() => {
		setIsSessionPreviewExpanded(false);
	}, [card.id, sessionActivity?.text]);

	useEffect(() => {
		setIsTrashHistoryExpanded(false);
	}, [card.id]);

	const sessionTimerStartedAt = sessionSummary?.startedAt ?? null;
	const isSessionTimerRunning = sessionSummary?.state === "running" && sessionTimerStartedAt !== null;

	useEffect(() => {
		setNowMs(Date.now());
	}, [card.id, sessionSummary?.state, sessionTimerStartedAt, sessionSummary?.updatedAt]);

	useInterval(
		() => {
			setNowMs(Date.now());
		},
		isSessionTimerRunning ? 1_000 : null,
	);

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const isDescriptionMeasured = descriptionRect.width > 0;
	const isSessionPreviewMeasured = sessionPreviewRect.width > 0;

	const descriptionDisplay = useMemo(() => {
		if (!displayPromptSplit.description) {
			return {
				text: "",
				isTruncated: false,
			};
		}
		if (descriptionWidth <= 0) {
			return {
				text: displayPromptSplit.description,
				isTruncated: false,
			};
		}
		return clampTextWithInlineSuffix(displayPromptSplit.description, {
			maxWidthPx: descriptionWidth,
			maxLines: DESCRIPTION_COLLAPSE_LINES,
			suffix: DESCRIPTION_COLLAPSE_SUFFIX,
			measureText: (value) => measureTextWidth(value, descriptionFont),
		});
	}, [descriptionFont, descriptionWidth, displayPromptSplit.description]);

	const sessionPreviewDisplay = useMemo(() => {
		if (!sessionActivity?.text) {
			return {
				text: "",
				isTruncated: false,
			};
		}
		if (sessionPreviewWidth <= 0) {
			return {
				text: sessionActivity.text,
				isTruncated: false,
			};
		}
		return clampTextWithInlineSuffix(sessionActivity.text, {
			maxWidthPx: sessionPreviewWidth,
			maxLines: SESSION_PREVIEW_COLLAPSE_LINES,
			suffix: DESCRIPTION_COLLAPSE_SUFFIX,
			measureText: (value) => measureTextWidth(value, sessionPreviewFont),
		});
	}, [sessionActivity?.text, sessionPreviewFont, sessionPreviewWidth]);

	const renderStatusMarker = () => {
		if (columnId === "in_progress") {
			if (sessionSummary?.state === "failed") {
				return <AlertCircle size={12} className="text-status-red" />;
			}
			return <Spinner size={12} />;
		}
		return null;
	};
	const statusMarker = renderStatusMarker();
	const showWorkspaceStatus = columnId === "in_progress" || columnId === "review" || isTrashCard;
	const reviewWorkspacePath = reviewWorkspaceSnapshot
		? formatPathForDisplay(reviewWorkspaceSnapshot.path)
		: isTrashCard
			? reconstructTaskWorktreeDisplayPath(card.id, workspacePath)
			: null;
	const reviewRefLabel = reviewWorkspaceSnapshot?.branch ?? reviewWorkspaceSnapshot?.headCommit?.slice(0, 8) ?? "HEAD";
	const reviewChangeSummary = reviewWorkspaceSnapshot
		? reviewWorkspaceSnapshot.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorkspaceSnapshot.changedFiles} ${reviewWorkspaceSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorkspaceSnapshot.additions ?? 0,
					deletions: reviewWorkspaceSnapshot.deletions ?? 0,
				}
		: null;
	const showReviewGitActions = columnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;
	const isAnyGitActionLoading = isCommitLoading || isOpenPrLoading;
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;
	const sessionTimerDurationMs =
		sessionTimerStartedAt === null
			? null
			: Math.max(0, (isSessionTimerRunning ? nowMs : (sessionSummary?.updatedAt ?? nowMs)) - sessionTimerStartedAt);
	const sessionTimerLabel =
		sessionTimerDurationMs === null ? null : formatSessionElapsedDuration(sessionTimerDurationMs);
	const explicitReleaseUrl = useMemo(() => findTaskReleaseUrl(sessionSummary), [sessionSummary]);
	const versionHint = useMemo(() => findVersionHint(card.prompt, sessionSummary), [card.prompt, sessionSummary]);
	useEffect(() => {
		let cancelled = false;
		if (!isTrashCard || explicitReleaseUrl) {
			setVerifiedReleaseUrl(null);
			return;
		}
		if (!versionHint || !homeRepositoryUrl) {
			setVerifiedReleaseUrl(null);
			return;
		}
		void getGithubReleaseUrlFromVersionHint(homeRepositoryUrl, versionHint).then((resolved) => {
			if (cancelled) {
				return;
			}
			setVerifiedReleaseUrl(resolved);
		});
		return () => {
			cancelled = true;
		};
	}, [explicitReleaseUrl, homeRepositoryUrl, isTrashCard, versionHint]);
	const completionStatusTags = useMemo(() => {
		if (columnId !== "review" && !isTrashCard) {
			return [];
		}
		const tags = getCompletedCardStatusTags(reviewWorkspaceSnapshot);
		if (!isTrashCard) {
			return tags;
		}
		const releaseUrl = explicitReleaseUrl ?? verifiedReleaseUrl;
		if (!releaseUrl) {
			return tags;
		}
		const releaseTag: CardStatusTag = {
			key: "github-release",
			label: "GitHub Release",
			tone: "success",
			href: releaseUrl,
		};
		return [releaseTag, ...tags];
	}, [columnId, explicitReleaseUrl, isTrashCard, reviewWorkspaceSnapshot, verifiedReleaseUrl]);
	const visibleActivityLogEntries = useMemo(
		() =>
			(sessionSummary?.activityLog ?? []).filter((entry) => entry.status === "success" || entry.status === "error"),
		[sessionSummary?.activityLog],
	);

	return (
		<Draggable draggableId={card.id} index={index} isDragDisabled={false}>
			{(provided, snapshot) => {
				const isDragging = snapshot.isDragging;
				const draggableContent = (
					<div
						ref={provided.innerRef}
						{...provided.draggableProps}
						{...provided.dragHandleProps}
						className="kb-board-card-shell"
						data-task-id={card.id}
						data-column-id={columnId}
						data-selected={selected}
						onMouseDownCapture={(event) => {
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (!event.metaKey && !event.ctrlKey) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							onDependencyPointerDown?.(card.id, event);
						}}
						onClick={(event) => {
							if (isTrashCard) {
								stopEvent(event);
								setIsTrashHistoryExpanded((previous) => !previous);
								return;
							}
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (event.metaKey || event.ctrlKey) {
								return;
							}
							if (!snapshot.isDragging && onClick) {
								onClick();
							}
						}}
						style={{
							...provided.draggableProps.style,
							marginBottom: 6,
							cursor: "grab",
						}}
						onMouseEnter={() => {
							setIsHovered(true);
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseMove={() => {
							if (!isDependencyLinking) {
								return;
							}
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseLeave={() => setIsHovered(false)}
					>
						<div
							className={cn(
								"rounded-md border border-border-bright bg-surface-2 p-2.5",
								isCardInteractive && "cursor-pointer hover:bg-surface-3 hover:border-border-bright",
								isDragging && "shadow-lg",
								isHovered && isCardInteractive && "bg-surface-3 border-border-bright",
								isDependencySource && "kb-board-card-dependency-source",
								isDependencyTarget && "kb-board-card-dependency-target",
							)}
						>
							<div className="flex items-center gap-2" style={{ minHeight: 24 }}>
								{statusMarker ? <div className="inline-flex items-center">{statusMarker}</div> : null}
								<div ref={titleContainerRef} className="flex-1 min-w-0">
									<p
										ref={titleRef}
										className={cn(
											"kb-line-clamp-1 m-0 font-medium text-sm",
											isTrashCard && "line-through text-text-tertiary",
										)}
									>
										{displayPromptSplit.title}
									</p>
								</div>
								{sessionTimerLabel ? (
									<span
										className="shrink-0 rounded-sm border border-border bg-surface-1 px-1.5 py-0.5 font-mono text-[11px] leading-none text-text-secondary"
										title={`Elapsed time ${sessionTimerLabel}`}
									>
										{sessionTimerLabel}
									</span>
								) : null}
								{isAwaitingUserInput ? (
									<span className="kb-board-card-input-blinker" title="Waiting for user input" />
								) : null}
								{columnId === "backlog" ? (
									<Button
										icon={<Play size={14} />}
										variant="ghost"
										size="sm"
										aria-label="Start task"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onStart?.(card.id);
										}}
									/>
								) : columnId === "review" ? (
									<Button
										icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
										variant="ghost"
										size="sm"
										disabled={isMoveToTrashLoading}
										aria-label="Move task to trash"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onMoveToTrash?.(card.id);
										}}
									/>
								) : columnId === "trash" ? (
									<Tooltip
										side="bottom"
										content={
											<>
												Restore session
												<br />
												in new worktree
											</>
										}
									>
										<Button
											icon={<RotateCcw size={12} />}
											variant="ghost"
											size="sm"
											aria-label="Restore task from trash"
											onMouseDown={stopEvent}
											onClick={(event) => {
												stopEvent(event);
												onRestoreFromTrash?.(card.id);
											}}
										/>
									</Tooltip>
								) : null}
							</div>
							{displayPromptSplit.description ? (
								<div ref={descriptionContainerRef}>
									<p
										ref={descriptionRef}
										className={cn(
											"text-sm leading-[1.4]",
											isTrashCard ? "text-text-tertiary" : "text-text-secondary",
											!isDescriptionMeasured && !isDescriptionExpanded && "line-clamp-3",
										)}
										style={{
											margin: "2px 0 0",
										}}
									>
										{isDescriptionExpanded || !descriptionDisplay.isTruncated
											? displayPromptSplit.description
											: descriptionDisplay.text}
										{descriptionDisplay.isTruncated ? (
											isDescriptionExpanded ? (
												<>
													{" "}
													<button
														type="button"
														className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
														aria-expanded={isDescriptionExpanded}
														aria-label="Collapse task description"
														onMouseDown={stopEvent}
														onClick={(event) => {
															stopEvent(event);
															setIsDescriptionExpanded(false);
														}}
													>
														{DESCRIPTION_COLLAPSE_LABEL}
													</button>
												</>
											) : (
												<>
													{"… "}
													<button
														type="button"
														className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
														aria-expanded={isDescriptionExpanded}
														aria-label="Expand task description"
														onMouseDown={stopEvent}
														onClick={(event) => {
															stopEvent(event);
															setIsDescriptionExpanded(true);
														}}
													>
														{DESCRIPTION_EXPAND_LABEL}
													</button>
												</>
											)
										) : null}
									</p>
								</div>
							) : null}
							{completionStatusTags.length > 0 ? (
								<div className="mt-1.5 flex flex-wrap gap-1">
									{completionStatusTags.map((tag) =>
										tag.href ? (
											<a
												key={tag.key}
												href={tag.href}
												target="_blank"
												rel="noreferrer"
												onMouseDown={stopEvent}
												onClick={stopEvent}
												className={cn(
													"inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] leading-none underline-offset-2 hover:underline",
													COMPLETED_CARD_STATUS_TAG_CLASS_BY_TONE[tag.tone],
												)}
											>
												{tag.label}
											</a>
										) : (
											<span
												key={tag.key}
												className={cn(
													"inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] leading-none",
													COMPLETED_CARD_STATUS_TAG_CLASS_BY_TONE[tag.tone],
												)}
											>
												{tag.label}
											</span>
										),
									)}
								</div>
							) : null}
							{sessionActivity ? (
								<div
									className="flex gap-1.5 items-start mt-[6px]"
									style={{
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									<span
										className="inline-block shrink-0 rounded-full"
										style={{
											width: 6,
											height: 6,
											backgroundColor: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : sessionActivity.dotColor,
											marginTop: 4,
										}}
									/>
									<div ref={sessionPreviewContainerRef} className="min-w-0 flex-1">
										<p
											ref={sessionPreviewRef}
											className={cn(
												"m-0 font-mono",
												!isSessionPreviewMeasured && !isSessionPreviewExpanded && "line-clamp-6",
											)}
											style={{
												fontSize: 12,
												whiteSpace: "normal",
												overflowWrap: "anywhere",
											}}
										>
											{isSessionPreviewExpanded || !sessionPreviewDisplay.isTruncated
												? sessionActivity.text
												: sessionPreviewDisplay.text}
											{sessionPreviewDisplay.isTruncated ? (
												isSessionPreviewExpanded ? (
													<>
														{" "}
														<button
															type="button"
															className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
															aria-expanded={isSessionPreviewExpanded}
															aria-label="Collapse task agent preview"
															onMouseDown={stopEvent}
															onClick={(event) => {
																stopEvent(event);
																setIsSessionPreviewExpanded(false);
															}}
														>
															{DESCRIPTION_COLLAPSE_LABEL}
														</button>
													</>
												) : (
													<>
														{"… "}
														<button
															type="button"
															className="inline cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [color:inherit] [font:inherit]"
															aria-expanded={isSessionPreviewExpanded}
															aria-label="Expand task agent preview"
															onMouseDown={stopEvent}
															onClick={(event) => {
																stopEvent(event);
																setIsSessionPreviewExpanded(true);
															}}
														>
															{DESCRIPTION_EXPAND_LABEL}
														</button>
													</>
												)
											) : null}
										</p>
									</div>
								</div>
							) : null}
							{isTrashCard && isTrashHistoryExpanded && visibleActivityLogEntries.length > 0 ? (
								<div className="mt-2 rounded-md border border-border bg-surface-1 p-2">
									<p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
										Task History
									</p>
									<ul className="mt-1.5 space-y-1.5 pl-4">
										{visibleActivityLogEntries.map((entry) => (
											<li
												key={entry.id}
												className={cn(
													"text-[12px] leading-[1.35] list-disc",
													entry.status === "error" ? "text-status-red" : "text-text-secondary",
												)}
											>
												{entry.text}
											</li>
										))}
									</ul>
								</div>
							) : null}
							{showWorkspaceStatus && reviewWorkspacePath ? (
								<p
									className="font-mono"
									style={{
										margin: "4px 0 0",
										fontSize: 12,
										lineHeight: 1.4,
										whiteSpace: "normal",
										overflowWrap: "anywhere",
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									{isTrashCard ? (
										<span
											style={{
												color: SESSION_ACTIVITY_COLOR.muted,
												textDecoration: "line-through",
											}}
										>
											{reviewWorkspacePath}
										</span>
									) : reviewWorkspaceSnapshot ? (
										<>
											<span style={{ color: SESSION_ACTIVITY_COLOR.secondary }}>{reviewWorkspacePath}</span>
											<GitBranch
												size={10}
												style={{
													display: "inline",
													color: SESSION_ACTIVITY_COLOR.secondary,
													margin: "0px 4px 2px",
													verticalAlign: "middle",
												}}
											/>
											<span style={{ color: SESSION_ACTIVITY_COLOR.secondary }}>{reviewRefLabel}</span>
											{reviewChangeSummary ? (
												<>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}> (</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>
														{reviewChangeSummary.filesLabel}
													</span>
													<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
													<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>)</span>
												</>
											) : null}
										</>
									) : null}
								</p>
							) : null}
							{showReviewGitActions ? (
								<div className="flex gap-1.5 mt-1.5">
									<Button
										variant="primary"
										size="sm"
										icon={isCommitLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onCommit?.(card.id);
										}}
									>
										Commit
									</Button>
									<Button
										variant="primary"
										size="sm"
										icon={isOpenPrLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onOpenPr?.(card.id);
										}}
									>
										Open PR
									</Button>
								</div>
							) : null}
							{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
								<Button
									size="sm"
									fill
									style={{ marginTop: 12 }}
									onMouseDown={stopEvent}
									onClick={(event) => {
										stopEvent(event);
										onCancelAutomaticAction(card.id);
									}}
								>
									{cancelAutomaticActionLabel}
								</Button>
							) : null}
						</div>
					</div>
				);

				if (isDragging && typeof document !== "undefined") {
					return createPortal(draggableContent, document.body);
				}
				return draggableContent;
			}}
		</Draggable>
	);
}
