// Versioned database schema for the tilt-series registration review chamber.
// All domain tables use electron-tomography vocabulary directly:
// tilt series, tilt frames, tilt axis, fiducial tracks, tracking gaps,
// identity swaps, manual frame exclusions, registration candidates.

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'tilt_stitch_chamber_v1',
    up: `
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Immutably stored imported bytes. Never mutated; referenced by digest.
    CREATE TABLE raw_blob (
      blob_id        TEXT PRIMARY KEY,   -- RAW_BLOB__ prefix, stable identity
      sha256         TEXT NOT NULL UNIQUE,
      byte_length    INTEGER NOT NULL,
      media_type     TEXT NOT NULL,
      original_name  TEXT NOT NULL,
      bytes          BLOB NOT NULL,
      imported_at    TEXT NOT NULL
    );

    -- A parseable source document inside an import session (e.g. one .tsf plate).
    CREATE TABLE source_document (
      document_id    TEXT PRIMARY KEY,
      import_batch   TEXT NOT NULL,
      kind           TEXT NOT NULL,      -- tilt_series_manifest | frame_image | tilt_table | dose_table | pixel_scale | fiducial_table | exclusion_reason
      blob_id        TEXT NOT NULL REFERENCES raw_blob(blob_id),
      raw_repr       TEXT NOT NULL,      -- original textual representation, preserved
      parse_status   TEXT NOT NULL,      -- parsed | unconvertible
      diagnostic     TEXT,               -- JSON diagnostic when value cannot normalize
      imported_at    TEXT NOT NULL
    );

    -- Tilt series (project) entity, itself versioned.
    CREATE TABLE tilt_series_entity (
      series_entity_id TEXT PRIMARY KEY,
      current_version_id TEXT
    );
    CREATE TABLE tilt_series_version (
      version_id     TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL REFERENCES tilt_series_entity(series_entity_id),
      version_no     INTEGER NOT NULL,
      slug           TEXT NOT NULL,
      title          TEXT NOT NULL,
      coordinate_frame TEXT NOT NULL,    -- pixel_center_upper_left etc.
      created_at     TEXT NOT NULL,
      created_by_event TEXT,
      UNIQUE (series_entity_id, version_no)
    );

    -- Raw tilt frames: immutable image bytes + per-frame versioned metadata.
    CREATE TABLE frame_entity (
      frame_entity_id TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      ordinal         INTEGER NOT NULL,
      current_version_id TEXT,
      UNIQUE (series_entity_id, ordinal)
    );
    CREATE TABLE frame_version (
      version_id     TEXT PRIMARY KEY,
      frame_entity_id TEXT NOT NULL REFERENCES frame_entity(frame_entity_id),
      version_no     INTEGER NOT NULL,
      blob_id        TEXT NOT NULL REFERENCES raw_blob(blob_id),
      width_px       INTEGER,
      height_px      INTEGER,
      source_repr    TEXT NOT NULL,      -- original line/record representation
      diagnostic     TEXT,
      created_by_event TEXT,
      UNIQUE (frame_entity_id, version_no)
    );

    -- Tilt angle, versioned, with unit + original representation.
    CREATE TABLE tilt_angle_entity (
      angle_entity_id TEXT PRIMARY KEY,
      frame_entity_id TEXT NOT NULL,
      current_version_id TEXT
    );
    CREATE TABLE tilt_angle_version (
      version_id     TEXT PRIMARY KEY,
      angle_entity_id TEXT NOT NULL REFERENCES tilt_angle_entity(angle_entity_id),
      version_no     INTEGER NOT NULL,
      value_deg      REAL,               -- normalized; NULL when unconvertible
      unit           TEXT NOT NULL,      -- degree | radian | unknown
      raw_value      TEXT NOT NULL,
      direction      TEXT NOT NULL,      -- untilt_sign_convention recorded
      diagnostic     TEXT,
      created_by_event TEXT,
      UNIQUE (angle_entity_id, version_no)
    );

    -- Pixel scale (image sampling), versioned, with units + reference.
    CREATE TABLE pixel_scale_entity (
      scale_entity_id TEXT PRIMARY KEY,
      scope          TEXT NOT NULL,      -- series | frame
      target_entity_id TEXT NOT NULL,
      current_version_id TEXT
    );
    CREATE TABLE pixel_scale_version (
      version_id     TEXT PRIMARY KEY,
      scale_entity_id TEXT NOT NULL REFERENCES pixel_scale_entity(scale_entity_id),
      version_no     INTEGER NOT NULL,
      angstrom_per_px REAL,             -- normalized; NULL when unconvertible
      raw_value      TEXT NOT NULL,
      raw_unit       TEXT NOT NULL,
      coordinate_basis TEXT NOT NULL,    -- image_pixel | binned_pixel
      binning        INTEGER,
      diagnostic     TEXT,
      created_by_event TEXT,
      UNIQUE (scale_entity_id, version_no)
    );

    -- Exposure dose per frame, versioned, with units.
    CREATE TABLE dose_entity (
      dose_entity_id TEXT PRIMARY KEY,
      frame_entity_id TEXT NOT NULL,
      current_version_id TEXT
    );
    CREATE TABLE dose_version (
      version_id     TEXT PRIMARY KEY,
      dose_entity_id TEXT NOT NULL REFERENCES dose_entity(dose_entity_id),
      version_no     INTEGER NOT NULL,
      electrons_per_angstrom2 REAL,      -- normalized; NULL when unconvertible
      raw_value      TEXT NOT NULL,
      raw_unit       TEXT NOT NULL,
      diagnostic     TEXT,
      created_by_event TEXT,
      UNIQUE (dose_entity_id, version_no)
    );

    -- Fiducial marker tracks: may be broken (gaps) and identity may be swapped.
    CREATE TABLE track_entity (
      track_entity_id TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      nominal_label  TEXT NOT NULL,      -- imported label, identity not guaranteed
      current_version_id TEXT
    );
    CREATE TABLE track_version (
      version_id     TEXT PRIMARY KEY,
      track_entity_id TEXT NOT NULL REFERENCES track_entity(track_entity_id),
      version_no     INTEGER NOT NULL,
      status         TEXT NOT NULL,      -- intact | broken | identity_ambiguous
      note           TEXT,
      created_by_event TEXT,
      UNIQUE (track_entity_id, version_no)
    );
    CREATE TABLE fiducial_point (
      point_id       TEXT PRIMARY KEY,
      track_version_id TEXT NOT NULL REFERENCES track_version(version_id),
      frame_version_id TEXT NOT NULL REFERENCES frame_version(version_id),
      x_px           REAL NOT NULL,
      y_px           REAL NOT NULL,
      coordinate_basis TEXT NOT NULL,
      UNIQUE (track_version_id, frame_version_id)
    );

    -- Tracking gaps: frames where the marker could not be tracked.
    CREATE TABLE gap_entity (
      gap_entity_id TEXT PRIMARY KEY,
      track_entity_id TEXT NOT NULL,
      current_version_id TEXT
    );
    CREATE TABLE gap_version (
      version_id     TEXT PRIMARY KEY,
      gap_entity_id TEXT NOT NULL REFERENCES gap_entity(gap_entity_id),
      version_no     INTEGER NOT NULL,
      frame_entity_id TEXT NOT NULL,     -- the frame missing from the track
      reason_code    TEXT NOT NULL,      -- occluded | out_of_field | untracked
      raw_repr       TEXT NOT NULL,
      created_by_event TEXT,
      UNIQUE (gap_entity_id, version_no)
    );

    -- Suspected fiducial identity swaps between tracks over a frame range.
    CREATE TABLE swap_entity (
      swap_entity_id TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      current_version_id TEXT
    );
    CREATE TABLE swap_version (
      version_id     TEXT PRIMARY KEY,
      swap_entity_id TEXT NOT NULL REFERENCES swap_entity(swap_entity_id),
      version_no     INTEGER NOT NULL,
      track_a_entity_id TEXT NOT NULL,
      track_b_entity_id TEXT NOT NULL,
      between_frame_ordinal INTEGER NOT NULL,
      confidence     TEXT NOT NULL,      -- confirmed | ambiguous
      raw_repr       TEXT NOT NULL,
      created_by_event TEXT,
      UNIQUE (swap_entity_id, version_no)
    );

    -- Manual frame exclusion reasons, versioned.
    CREATE TABLE exclusion_entity (
      exclusion_entity_id TEXT PRIMARY KEY,
      frame_entity_id TEXT NOT NULL,
      current_version_id TEXT
    );
    CREATE TABLE exclusion_version (
      version_id     TEXT PRIMARY KEY,
      exclusion_entity_id TEXT NOT NULL REFERENCES exclusion_entity(exclusion_entity_id),
      version_no     INTEGER NOT NULL,
      reason_code    TEXT NOT NULL,      -- too_much_motion | drift_failure | ice_contamination | beam_blocked | low_dose_noise
      reason_detail  TEXT NOT NULL,
      author         TEXT NOT NULL,
      raw_repr       TEXT NOT NULL,
      created_by_event TEXT,
      UNIQUE (exclusion_entity_id, version_no)
    );

    -- Tilt axis: eccentricity is an explicit parameter; never assumed at image center.
    CREATE TABLE tilt_axis_entity (
      axis_entity_id TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      current_version_id TEXT
    );
    CREATE TABLE tilt_axis_version (
      version_id     TEXT PRIMARY KEY,
      axis_entity_id TEXT NOT NULL REFERENCES tilt_axis_entity(axis_entity_id),
      version_no     INTEGER NOT NULL,
      angle_deg      REAL NOT NULL,      -- axis orientation in image plane
      pivot_x_px     REAL,               -- NULL = unknown, NOT silently set to image center
      pivot_y_px     REAL,
      assumed_center INTEGER NOT NULL,   -- 1 only if a candidate assumed center (flagged)
      eccentricity_known INTEGER NOT NULL,
      raw_repr       TEXT NOT NULL,
      diagnostic     TEXT,
      created_by_event TEXT,
      UNIQUE (axis_entity_id, version_no)
    );

    -- Named parameter/rule sets; changing one invalidates dependents via dependency graph.
    CREATE TABLE param_set_version (
      param_set_id   TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      version_no     INTEGER NOT NULL,
      kind           TEXT NOT NULL,      -- rigid | local_deformable | bad_frame_exclusion | compare_policy
      label          TEXT NOT NULL,
      body_json      TEXT NOT NULL,
      created_by_event TEXT,
      UNIQUE (param_set_id, version_no)
    );

    -- Registration candidates (branches). Scores measured on the SAME effective point set.
    CREATE TABLE registration_candidate (
      candidate_id   TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      branch_id      TEXT NOT NULL,
      kind           TEXT NOT NULL,      -- rigid | local_deformable | rigid_excluding_bad_frames
      label          TEXT NOT NULL,
      param_set_id   TEXT NOT NULL,      -- explicit param version reference
      axis_version_id TEXT,              -- explicit axis version reference (may be null for joint-fit)
      effective_point_set_hash TEXT NOT NULL,
      frame_count_total INTEGER NOT NULL,
      frame_count_used  INTEGER NOT NULL,
      excluded_frame_entity_ids TEXT NOT NULL, -- JSON array, explicit not silent
      rms_residual_px REAL NOT NULL,    -- computed on shared effective point set
      max_residual_px REAL NOT NULL,
      overfit_score  REAL NOT NULL,      -- leave-one-track-out degradation
      transform_json TEXT NOT NULL,
      ambiguity_group_id TEXT,           -- non-null when multiple legal solutions tied
      status         TEXT NOT NULL,      -- proposed | accepted | rejected | superseded | invalidated
      created_at     TEXT NOT NULL
    );
    CREATE INDEX idx_candidate_branch ON registration_candidate(branch_id);

    -- Per-frame residual rows for the review page.
    CREATE TABLE candidate_frame_residual (
      residual_id    TEXT PRIMARY KEY,
      candidate_id   TEXT NOT NULL REFERENCES registration_candidate(candidate_id),
      frame_entity_id TEXT NOT NULL,
      residual_px    REAL NOT NULL,
      used_fiducials INTEGER NOT NULL,
      excluded       INTEGER NOT NULL
    );

    -- Machine-readable rule findings (judgement evidence), each with stable identity.
    CREATE TABLE candidate_finding (
      finding_id     TEXT PRIMARY KEY,
      candidate_id   TEXT NOT NULL REFERENCES registration_candidate(candidate_id),
      rule_code      TEXT NOT NULL,
      -- R_AXIS_NOT_CENTER | R_FIDUCIAL_SWAP | R_MISSING_HIGH_TILT | R_BAD_FRAME
      -- R_LOCAL_OVERFIT | R_MULTIPLE_SOLUTIONS | R_CONCURRENT_FREEZE
      -- R_FAIR_POINT_SET | R_NO_FRAME_TRADING
      severity       TEXT NOT NULL,      -- info | warning | violation | blocker
      message        TEXT NOT NULL,
      evidence_json  TEXT NOT NULL
    );

    -- Review branches (interpretation lines). Old branches remain readable forever.
    CREATE TABLE review_branch (
      branch_id      TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      parent_branch_id TEXT,
      name           TEXT NOT NULL,
      created_from_event_id TEXT,
      status         TEXT NOT NULL,      -- open | abandoned | locked
      created_at     TEXT NOT NULL
    );

    -- Append-only branch event log. Every acceptance/rejection/parameter edit is an event.
    CREATE TABLE branch_event (
      event_id       TEXT PRIMARY KEY,
      branch_id      TEXT NOT NULL REFERENCES review_branch(branch_id),
      seq            INTEGER NOT NULL,
      event_type     TEXT NOT NULL,
      event_json     TEXT NOT NULL,
      actor          TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      undone_by_event_id TEXT,
      UNIQUE (branch_id, seq)
    );

    -- A locked registration chosen for reconstruction reference.
    CREATE TABLE registration_lock (
      lock_id        TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      branch_id      TEXT NOT NULL,
      candidate_id   TEXT NOT NULL REFERENCES registration_candidate(candidate_id),
      lock_event_id  TEXT NOT NULL,
      active         INTEGER NOT NULL,
      created_at     TEXT NOT NULL,
      released_by_event_id TEXT
    );

    -- Dependency graph: entities/versions invalidate dependents when sources change.
    CREATE TABLE dependency_edge (
      edge_id        TEXT PRIMARY KEY,
      dependent_type TEXT NOT NULL,      -- candidate | lock | finding
      dependent_id   TEXT NOT NULL,
      dependency_type TEXT NOT NULL,     -- frame_version | angle_version | ... | param_set
      dependency_id  TEXT NOT NULL,
      UNIQUE (dependent_id, dependency_id)
    );

    -- Named viewpoints (review-page view state), stored as events not raw edits.
    CREATE TABLE view_state (
      view_id        TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      name           TEXT NOT NULL,
      state_json     TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );

    -- Optimistic concurrency token. Bumped on every write; used for freeze conflicts.
    INSERT INTO meta (key, value) VALUES ('db_revision', '0');
    INSERT INTO meta (key, value) VALUES ('database_role', 'tilt_stitch_chamber');
    `
  },
  {
    version: 2,
    name: 'tilt_stitch_chamber_v2_archive_note',
    up: `
    CREATE TABLE archive_note (
      note_id TEXT PRIMARY KEY,
      series_entity_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    `
  }
];
