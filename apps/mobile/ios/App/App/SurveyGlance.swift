import ActivityKit
import Foundation

/// The running survey on the locked screen and in the Dynamic Island, where
/// Android has its ongoing notice: a Live Activity.
///
/// iOS lets one begin only while the app is on screen, which is where a survey
/// is started. After that it is brought up to date from wherever the app runs,
/// and a survey keeps the app running out of sight (the `location` background
/// mode, `MeshRelay.followPhone`). Live Activities came with iOS 16; on an
/// older phone, or with them turned off for the app in Settings, nothing shows
/// and the survey goes on the same.
enum SurveyGlance {
    /// Shows what the radio core says of the survey (its status JSON, `survey.rs`):
    /// begins the activity, or brings the one there up to date.
    static func show(status json: String) {
        guard #available(iOS 16.2, *) else { return }
        guard let data = json.data(using: .utf8),
              let status = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let last = (status["points"] as? [[String: Any]])?.last
        let state = SurveyAttributes.ContentState(
            title: status["title"] as? String ?? "",
            line: status["line"] as? String ?? "",
            points: status["count"] as? Int ?? 0,
            answered: last.map { ($0["replies"] as? [Any])?.isEmpty == false }
        )
        let content = ActivityContent(state: state, staleDate: nil)
        if let activity = Activity<SurveyAttributes>.activities.first {
            Task { await activity.update(content) }
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let startedAt = Date(timeIntervalSince1970: (status["startedAt"] as? Double ?? 0) / 1000)
        do {
            _ = try Activity.request(attributes: SurveyAttributes(startedAt: startedAt), content: content, pushType: nil)
        } catch {
            // Out of sight iOS refuses a new one: the reader swiped the last away, and sees the survey in the app.
            NSLog("SurveyGlance: the survey is not on the locked screen: %@", error.localizedDescription)
        }
    }

    /// Takes the survey off the locked screen: it was stopped, or the app that ran it is gone.
    static func end() {
        guard #available(iOS 16.2, *) else { return }
        Task {
            for activity in Activity<SurveyAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }
}
