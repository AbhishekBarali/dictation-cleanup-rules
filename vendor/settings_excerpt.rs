pub enum Capitalization {
    /// Leave the replacement text as written.
    #[default]
    None,
    /// UPPERCASE the whole replacement.
    Uppercase,
    /// lowercase the whole replacement.
    Lowercase,
    /// Capitalize the first character of the replacement.
    Capitalize,
}

/// A single deterministic find/replace rule applied to the transcript.
///
/// Rules run as a fast, offline, deterministic pass that complements (does not
/// duplicate) the optional LLM post-processing. `search` is matched literally
/// by default; set `is_regex` to treat it as a regular expression. `replace`
/// may contain magic commands such as `[date]`, `[time]`, `[uppercase]`,
/// `[lowercase]`, `[capitalize]`, and `[nospace]`.
#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct Replacement {
    /// Text (or regex pattern when `is_regex` is set) to search for.
    pub search: String,
    /// Replacement text. Supports the magic commands described on the struct.
    pub replace: String,
    /// Treat `search` as a regular expression instead of a literal string.
    #[serde(default)]
    pub is_regex: bool,
    /// Whether this rule is applied. Disabled rules are kept but skipped.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Remove whitespace immediately before each match.
    #[serde(default)]
    pub trim_before: bool,
    /// Remove whitespace immediately after each match.
    #[serde(default)]
    pub trim_after: bool,
    /// Case transform applied to this rule's output.
    #[serde(default)]
    pub capitalization: Capitalization,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct PostProcessProvider {
    pub id: String,
    pub label: String,
