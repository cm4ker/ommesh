import ActivityKit
import Foundation

/// A coverage survey running, as iOS shows it on the locked screen and in the
/// Dynamic Island (a Live Activity). The app says what to show (`SurveyGlance`)
/// and the `SurveyActivity` extension draws it, so this file is in both targets.
///
/// The words are the radio core's (`title` and `line` of its survey status,
/// `survey.rs`), already in the reader's language: the extension has no words
/// of its own.
@available(iOS 16.2, *)
struct SurveyAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// "Survey running · 25 points".
        var title: String
        /// Who heard the last point, or why none is being made.
        var line: String
        var points: Int
        /// Whether a repeater answered at the last point; nil before the first.
        var answered: Bool?
    }

    /// When the survey began: the activity counts its time up from here by itself.
    var startedAt: Date
}
