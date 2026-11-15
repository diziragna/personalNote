// Validation rules shared by the API functions and the desktop app, so a note is checked the same way everywhere.

pub fn valid_username(name: &str) -> bool {
    (3..=24).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn valid_password(password: &str) -> bool { (8..=128).contains(&password.len()) }

pub fn parse_due_date(value: Option<&str>) -> Result<Option<chrono::NaiveDate>, ()> {
    match value {
        None | Some("") => Ok(None),
        Some(value) => chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map(Some).map_err(|_| ()),
    }
}

pub const NOTE_COLORS: [&str; 6] = ["yellow", "pink", "blue", "green", "purple", "orange"];

pub fn valid_color(color: &str) -> bool { NOTE_COLORS.contains(&color) }

pub fn valid_position(value: i32) -> bool { (0..=100_000).contains(&value) }

pub fn valid_width(value: i32) -> bool { (180..=1200).contains(&value) }

pub fn valid_height(value: i32) -> bool { (120..=1200).contains(&value) }

/// Returns an error message when any provided field is out of range.
pub fn invalid_fields(title: Option<&str>, content: Option<&str>, color: Option<&str>, positions: &[Option<i32>]) -> Option<&'static str> {
    if title.is_some_and(|t| t.trim().chars().count() > 120) { return Some("A title can be at most 120 characters.") }
    if content.is_some_and(|c| c.trim().chars().count() > 2000) { return Some("A note can be at most 2,000 characters.") }
    if color.is_some_and(|c| !valid_color(c)) { return Some("Choose one of the available note colors.") }
    if positions.iter().flatten().any(|&v| !valid_position(v)) { return Some("That note position is out of range.") }
    None
}
