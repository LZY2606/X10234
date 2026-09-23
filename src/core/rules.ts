// Explicit, versioned domain rules.  Every derived object records the rule
// version that produced it so an old event can always be interpreted with the
// rules that were in force at the time.

export const RULE_VERSION = 'tilt-room-rules-2026.1';

export interface RuleStatement {
  id: string;
  version: string;
  statement: string;
}

export const RULES: RuleStatement[] = [
  {
    id: 'axis-not-centre',
    version: RULE_VERSION,
    statement:
      'The tilt axis is an oriented line with an explicit offset; it must never be defaulted to the image centre without a recorded assumption.'
  },
  {
    id: 'tracks-break-and-swap',
    version: RULE_VERSION,
    statement:
      'Fiducial trajectories may be interrupted by tracking gaps and may exchange identity; gaps and swaps are first-class inputs, not cleaned on import.'
  },
  {
    id: 'same-effective-set',
    version: RULE_VERSION,
    statement:
      'Alignment candidates are compared on the identical effective point set (fingerprint of frame x track pairs); fewer frames must never buy a lower residual.'
  },
  {
    id: 'no-irreversible-cleaning',
    version: RULE_VERSION,
    statement:
      'Import performs no irreversible cleaning; unconvertible quantities stay in place with diagnostics and rollback removes a failed import completely.'
  },
  {
    id: 'multi-solution-kept',
    version: RULE_VERSION,
    statement:
      'When the data do not determine a unique solution, every legal candidate is retained in an ambiguity set; none is silently promoted.'
  },
  {
    id: 'branch-and-revert',
    version: RULE_VERSION,
    statement:
      'Review accept/reject/parameter-adjust decisions are append-only events on branches and can be reverted to restore the prior branch state.'
  },
  {
    id: 'dependency-invalidation',
    version: RULE_VERSION,
    statement:
      'When a source or rule version changes, dependency analysis computes the invalidation scope; old conclusions are never globally and silently replaced.'
  },
  {
    id: 'concurrency-oc-c',
    version: RULE_VERSION,
    statement:
      'Concurrent saves use optimistic concurrency on the branch head; the stale writer sees a conflict with both sides of the diff.'
  }
];
