//! Thin N-API wrappers around the official `headroom-core` crushers.
//!
//! Shapes follow `crates/headroom-py` so plugin tests can replay the same
//! parity fixtures the PyO3 bridge uses.

use headroom_core::ccr::InMemoryCcrStore;
use headroom_core::transforms::content_detector::detect_content_type;
use headroom_core::transforms::smart_crusher::{SmartCrusher, SmartCrusherConfig};
use headroom_core::transforms::{
    DiffCompressor, DiffCompressorConfig, LogCompressor, LogCompressorConfig, SearchCompressor,
    SearchCompressorConfig, TextCrusher, TextCrusherConfig,
};
use napi_derive::napi;
use serde_json::Value;

#[napi(object)]
pub struct CrushOut {
    pub compressed: String,
    pub was_modified: bool,
    pub strategy: String,
    pub original_tokens: Option<u32>,
    pub compressed_tokens: Option<u32>,
    pub compression_ratio: Option<f64>,
    pub kept_segments: Option<u32>,
    pub total_segments: Option<u32>,
}

#[napi(object)]
pub struct DetectOut {
    pub content_type: String,
    pub confidence: f64,
    pub metadata_json: String,
}

fn usize_or(config: Option<&Value>, key: &str, default: usize) -> usize {
    config
        .and_then(|v| v.get(key))
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(default)
}

fn bool_or(config: Option<&Value>, key: &str, default: bool) -> bool {
    config
        .and_then(|v| v.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn f64_or(config: Option<&Value>, key: &str, default: f64) -> f64 {
    config
        .and_then(|v| v.get(key))
        .and_then(Value::as_f64)
        .unwrap_or(default)
}

fn log_config(config: Option<&Value>) -> LogCompressorConfig {
    let defaults = LogCompressorConfig::default();
    LogCompressorConfig {
        max_errors: usize_or(config, "max_errors", defaults.max_errors),
        error_context_lines: usize_or(config, "error_context_lines", defaults.error_context_lines),
        keep_first_error: bool_or(config, "keep_first_error", defaults.keep_first_error),
        keep_last_error: bool_or(config, "keep_last_error", defaults.keep_last_error),
        max_stack_traces: usize_or(config, "max_stack_traces", defaults.max_stack_traces),
        stack_trace_max_lines: usize_or(
            config,
            "stack_trace_max_lines",
            defaults.stack_trace_max_lines,
        ),
        max_warnings: usize_or(config, "max_warnings", defaults.max_warnings),
        dedupe_warnings: bool_or(config, "dedupe_warnings", defaults.dedupe_warnings),
        keep_summary_lines: bool_or(config, "keep_summary_lines", defaults.keep_summary_lines),
        max_total_lines: usize_or(config, "max_total_lines", defaults.max_total_lines),
        enable_ccr: bool_or(config, "enable_ccr", defaults.enable_ccr),
        min_lines_for_ccr: usize_or(config, "min_lines_for_ccr", defaults.min_lines_for_ccr),
        min_compression_ratio_for_ccr: f64_or(
            config,
            "min_compression_ratio_for_ccr",
            defaults.min_compression_ratio_for_ccr,
        ),
        collapse_runtime_frames: bool_or(
            config,
            "collapse_runtime_frames",
            defaults.collapse_runtime_frames,
        ),
        trace_head_frames: usize_or(config, "trace_head_frames", defaults.trace_head_frames),
        trace_app_frames: usize_or(config, "trace_app_frames", defaults.trace_app_frames),
    }
}

fn smart_config(config: Option<&Value>) -> SmartCrusherConfig {
    let defaults = SmartCrusherConfig::default();
    SmartCrusherConfig {
        enabled: bool_or(config, "enabled", defaults.enabled),
        min_items_to_analyze: usize_or(
            config,
            "min_items_to_analyze",
            defaults.min_items_to_analyze,
        ),
        min_tokens_to_crush: usize_or(config, "min_tokens_to_crush", defaults.min_tokens_to_crush),
        variance_threshold: f64_or(config, "variance_threshold", defaults.variance_threshold),
        uniqueness_threshold: f64_or(
            config,
            "uniqueness_threshold",
            defaults.uniqueness_threshold,
        ),
        similarity_threshold: f64_or(
            config,
            "similarity_threshold",
            defaults.similarity_threshold,
        ),
        max_items_after_crush: usize_or(
            config,
            "max_items_after_crush",
            defaults.max_items_after_crush,
        ),
        preserve_change_points: bool_or(
            config,
            "preserve_change_points",
            defaults.preserve_change_points,
        ),
        factor_out_constants: bool_or(config, "factor_out_constants", defaults.factor_out_constants),
        include_summaries: bool_or(config, "include_summaries", defaults.include_summaries),
        use_feedback_hints: bool_or(config, "use_feedback_hints", defaults.use_feedback_hints),
        toin_confidence_threshold: f64_or(
            config,
            "toin_confidence_threshold",
            defaults.toin_confidence_threshold,
        ),
        dedup_identical_items: bool_or(
            config,
            "dedup_identical_items",
            defaults.dedup_identical_items,
        ),
        first_fraction: f64_or(config, "first_fraction", defaults.first_fraction),
        last_fraction: f64_or(config, "last_fraction", defaults.last_fraction),
        relevance_threshold: f64_or(config, "relevance_threshold", defaults.relevance_threshold),
        lossless_min_savings_ratio: f64_or(
            config,
            "lossless_min_savings_ratio",
            defaults.lossless_min_savings_ratio,
        ),
        enable_ccr_marker: bool_or(config, "enable_ccr_marker", defaults.enable_ccr_marker),
        lossless_only: bool_or(config, "lossless_only", defaults.lossless_only),
        compaction_core_field_fraction: f64_or(
            config,
            "compaction_core_field_fraction",
            defaults.compaction_core_field_fraction,
        ),
        compaction_heterogeneous_core_ratio: f64_or(
            config,
            "compaction_heterogeneous_core_ratio",
            defaults.compaction_heterogeneous_core_ratio,
        ),
        compaction_max_flatten_inner_keys: usize_or(
            config,
            "compaction_max_flatten_inner_keys",
            defaults.compaction_max_flatten_inner_keys,
        ),
        compaction_min_buckets: usize_or(
            config,
            "compaction_min_buckets",
            defaults.compaction_min_buckets,
        ),
        compaction_max_buckets: usize_or(
            config,
            "compaction_max_buckets",
            defaults.compaction_max_buckets,
        ),
    }
}

fn search_config(config: Option<&Value>) -> SearchCompressorConfig {
    let defaults = SearchCompressorConfig::default();
    SearchCompressorConfig {
        max_matches_per_file: usize_or(
            config,
            "max_matches_per_file",
            defaults.max_matches_per_file,
        ),
        always_keep_first: bool_or(config, "always_keep_first", defaults.always_keep_first),
        always_keep_last: bool_or(config, "always_keep_last", defaults.always_keep_last),
        max_total_matches: usize_or(config, "max_total_matches", defaults.max_total_matches),
        max_files: usize_or(config, "max_files", defaults.max_files),
        context_keywords: config
            .and_then(|v| v.get("context_keywords"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or(defaults.context_keywords),
        boost_errors: bool_or(config, "boost_errors", defaults.boost_errors),
        enable_ccr: bool_or(config, "enable_ccr", defaults.enable_ccr),
        min_matches_for_ccr: usize_or(config, "min_matches_for_ccr", defaults.min_matches_for_ccr),
        min_compression_ratio_for_ccr: f64_or(
            config,
            "min_compression_ratio_for_ccr",
            defaults.min_compression_ratio_for_ccr,
        ),
        group_by_file: bool_or(config, "group_by_file", defaults.group_by_file),
    }
}

fn diff_config(config: Option<&Value>) -> DiffCompressorConfig {
    let defaults = DiffCompressorConfig::default();
    DiffCompressorConfig {
        max_context_lines: usize_or(config, "max_context_lines", defaults.max_context_lines),
        max_hunks_per_file: usize_or(config, "max_hunks_per_file", defaults.max_hunks_per_file),
        max_files: usize_or(config, "max_files", defaults.max_files),
        always_keep_additions: bool_or(
            config,
            "always_keep_additions",
            defaults.always_keep_additions,
        ),
        always_keep_deletions: bool_or(
            config,
            "always_keep_deletions",
            defaults.always_keep_deletions,
        ),
        enable_ccr: bool_or(config, "enable_ccr", defaults.enable_ccr),
        min_lines_for_ccr: usize_or(config, "min_lines_for_ccr", defaults.min_lines_for_ccr),
        min_compression_ratio_for_ccr: f64_or(
            config,
            "min_compression_ratio_for_ccr",
            defaults.min_compression_ratio_for_ccr,
        ),
    }
}

#[napi]
pub fn crush_log(content: String, config: Option<Value>, bias: Option<f64>) -> CrushOut {
    let store = InMemoryCcrStore::new();
    let (result, _stats) = LogCompressor::new(log_config(config.as_ref())).compress_with_store(
        &content,
        bias.unwrap_or(1.0),
        Some(&store),
    );
    CrushOut {
        compressed: result.compressed.clone(),
        was_modified: result.compressed != result.original,
        strategy: result.format_detected.as_str().to_string(),
        original_tokens: None,
        compressed_tokens: None,
        compression_ratio: Some(result.compression_ratio),
        kept_segments: None,
        total_segments: None,
    }
}

#[napi]
pub fn crush_smart(
    content: String,
    query: Option<String>,
    bias: Option<f64>,
    config: Option<Value>,
    without_compaction: Option<bool>,
) -> CrushOut {
    let cfg = smart_config(config.as_ref());
    let crusher = if without_compaction.unwrap_or(true) {
        SmartCrusher::without_compaction(cfg)
    } else {
        SmartCrusher::new(cfg)
    };
    let result = crusher.crush(&content, query.as_deref().unwrap_or(""), bias.unwrap_or(1.0));
    CrushOut {
        compressed: result.compressed,
        was_modified: result.was_modified,
        strategy: result.strategy,
        original_tokens: None,
        compressed_tokens: None,
        compression_ratio: None,
        kept_segments: None,
        total_segments: None,
    }
}

#[napi]
pub fn crush_text(
    content: String,
    context: Option<String>,
    target_ratio: Option<f64>,
) -> CrushOut {
    let result = TextCrusher::new(TextCrusherConfig::default()).compress(
        &content,
        context.as_deref().unwrap_or(""),
        target_ratio,
    );
    CrushOut {
        compressed: result.compressed.clone(),
        was_modified: result.compressed != content,
        strategy: "text".to_string(),
        original_tokens: Some(result.original_tokens as u32),
        compressed_tokens: Some(result.compressed_tokens as u32),
        compression_ratio: Some(result.compression_ratio),
        kept_segments: Some(result.kept_segments as u32),
        total_segments: Some(result.total_segments as u32),
    }
}

#[napi]
pub fn crush_search(
    content: String,
    context: Option<String>,
    bias: Option<f64>,
    config: Option<Value>,
) -> CrushOut {
    let store = InMemoryCcrStore::new();
    let (result, _stats) = SearchCompressor::new(search_config(config.as_ref())).compress_with_store(
        &content,
        context.as_deref().unwrap_or(""),
        bias.unwrap_or(1.0),
        Some(&store),
    );
    CrushOut {
        compressed: result.compressed.clone(),
        was_modified: result.compressed != result.original,
        strategy: "search".to_string(),
        original_tokens: None,
        compressed_tokens: None,
        compression_ratio: Some(result.compression_ratio),
        kept_segments: None,
        total_segments: None,
    }
}

#[napi]
pub fn crush_diff(content: String, context: Option<String>, config: Option<Value>) -> CrushOut {
    let store = InMemoryCcrStore::new();
    let (result, _stats) = DiffCompressor::new(diff_config(config.as_ref())).compress_with_store(
        &content,
        context.as_deref().unwrap_or(""),
        Some(&store),
    );
    CrushOut {
        compressed: result.compressed.clone(),
        was_modified: result.compressed_line_count != result.original_line_count,
        strategy: "diff".to_string(),
        original_tokens: None,
        compressed_tokens: None,
        compression_ratio: None,
        kept_segments: None,
        total_segments: None,
    }
}

#[napi]
pub fn detect_type(content: String) -> DetectOut {
    let result = detect_content_type(&content);
    DetectOut {
        content_type: result.content_type.as_str().to_string(),
        confidence: result.confidence,
        metadata_json: Value::Object(result.metadata).to_string(),
    }
}
