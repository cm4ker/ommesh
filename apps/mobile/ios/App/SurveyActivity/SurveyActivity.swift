import ActivityKit
import SwiftUI
import WidgetKit

/// Draws a running coverage survey on the locked screen and in the Dynamic
/// Island (a Live Activity). The app begins it and brings it up to date
/// (`SurveyGlance`); this only lays out what `SurveyAttributes` carries, in
/// the words the app gives it. The time counts up by itself, from when the
/// survey began, with no word from the app.
@main
struct SurveyActivityBundle: WidgetBundle {
    var body: some Widget {
        SurveyLiveActivity()
    }
}

struct SurveyLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SurveyAttributes.self) { context in
            SurveyBanner(state: context.state, since: context.attributes.startedAt)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SurveyMark(answered: context.state.answered).padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    SurveyClock(since: context.attributes.startedAt)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title).font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.line).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            } compactLeading: {
                SurveyMark(answered: context.state.answered)
            } compactTrailing: {
                Text("\(context.state.points)").monospacedDigit()
            } minimal: {
                Text("\(context.state.points)").monospacedDigit()
            }
        }
    }
}

/// The locked screen's card: how many points and for how long, and under it the last point.
struct SurveyBanner: View {
    let state: SurveyAttributes.ContentState
    let since: Date

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(state.title).font(.headline).lineLimit(1)
                HStack(spacing: 7) {
                    SurveyMark(answered: state.answered)
                    Text(state.line).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            SurveyClock(since: since).font(.title3)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// The last point as the map draws it: filled green where a repeater answered, hollow where
/// none did, grey before the first.
struct SurveyMark: View {
    let answered: Bool?

    var body: some View {
        Circle()
            .strokeBorder(answered == false ? Color.secondary : Color.clear, lineWidth: 2)
            .background(Circle().fill(answered == true ? Color.green : answered == nil ? Color.secondary : Color.clear))
            .frame(width: 10, height: 10)
    }
}

/// Minutes and seconds since the survey began, which the system keeps ticking.
struct SurveyClock: View {
    let since: Date

    var body: some View {
        // A timer takes all the width it is given, so it is given only what its digits need.
        Text(since, style: .timer)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 76, alignment: .trailing)
    }
}
