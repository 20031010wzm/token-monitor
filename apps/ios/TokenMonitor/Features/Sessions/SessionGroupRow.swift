import SwiftUI

/// A folded conversation group: the header quotes the latest
/// same-conversation row, the meter sums every member once, and expanding
/// lists mains (continuations of the header conversation) then subagents —
/// the same sections the desktop group page shows.
struct SessionGroupRow: View {
    let entry: SessionListEntry
    let maximum: Double
    let now: Date
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var expanded = false
    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0
    @ScaledMetric(relativeTo: .subheadline) private var markInset = 26.0

    private var display: SessionUsage? { entry.session }
    private var mains: [SessionListEntry.Member] { entry.members.filter(\.isMain) }
    private var subagents: [SessionListEntry.Member] { entry.members.filter { !$0.isMain } }

    /// One merged model readout for the group, like the desktop group row's
    /// rebuilt `modelLabel` — heaviest model or "N models" across all members.
    private var modelEntries: [BreakdownEntry] {
        var merged: [String: Double] = [:]
        for member in entry.members {
            for (model, tokens) in member.session.models ?? [:] {
                merged[model, default: 0] += tokens
            }
        }
        return merged.filter { !$0.key.isEmpty && $0.value.isFinite && $0.value > 0 }
            .map { BreakdownEntry(id: $0.key, value: $0.value, cost: 0) }
            .sorted { $0.value == $1.value ? $0.id < $1.id : $0.value > $1.value }
    }

    private var groupState: SessionActivityState { entry.activityState(at: now) }

    private var clientName: String {
        ClientPresentation.displayName(for: display?.client ?? "unknown")
    }

    private var modelLabel: String? {
        switch modelEntries.count {
        case 0: return nil
        case 1: return modelEntries[0].id
        default: return String(localized: "\(modelEntries.count) models")
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if display?.displayTitle != nil {
            parts.append(([clientName, modelLabel].compactMap { $0 }).joined(separator: " · "))
        } else {
            if let date = display?.lastActivity {
                let time = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
                    .locale(Locale(identifier: "en_US_POSIX"))
                parts.append(date.formatted(Calendar.current.isDate(date, inSameDayAs: now)
                                            ? time : time.month(.twoDigits).day(.twoDigits)))
            }
            if let count = display?.messageCount, count > 0 {
                parts.append("\(MetricFormatter.exactTokens(Double(count))) \(count == 1 ? "call" : "calls")")
            }
        }
        if entry.subagentCount > 0 {
            parts.append(String(localized: "\(entry.subagentCount) subagents"))
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.rowBarSpacing) {
            Button { expanded.toggle() } label: {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
                layout {
                    VStack(alignment: .leading, spacing: DesignTokens.rowLineSpacing) {
                        Text(display?.displayTitle ?? ([clientName, modelLabel].compactMap { $0 }.joined(separator: " · ")))
                            .font(DesignTokens.rowTitle)
                            .lineLimit(1).truncationMode(.tail)
                        if !subtitle.isEmpty {
                            Text(subtitle).font(.caption2).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.tail)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, markInset)
                    .overlay(alignment: .topLeading) {
                        ProviderMark(provider: display?.client, size: markSize)
                            .overlay(alignment: .bottomTrailing) {
                                switch groupState {
                                case .running:
                                    Circle().fill(.mint).frame(width: 5, height: 5)
                                        .overlay { Circle().stroke(.background, lineWidth: 1) }
                                        .accessibilityHidden(true)
                                case .waiting:
                                    Image(systemName: "exclamationmark.triangle.fill")
                                        .font(.system(size: 7))
                                        .foregroundStyle(.orange)
                                        .accessibilityHidden(true)
                                case .ended, .idle:
                                    EmptyView()
                                }
                            }
                    }
                    metrics
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect)
                .foregroundStyle(.primary)
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
            UsageMeter(value: entry.tokens, maximum: maximum,
                       color: ClientPresentation.color(for: display?.client ?? "unknown"))
            if expanded {
                LazyVStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                    let detailMaximum = UsageRowPresentation.maximum(entry.members.map { $0.session.measuredTokens })
                    Divider()
                    Text("Main session")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(mains, id: \.key) { member in
                        SessionRow(session: member.session, sessionKey: member.key,
                                   maximum: detailMaximum, now: now)
                    }
                    if !subagents.isEmpty {
                        Divider()
                        Text("Subagents · \(entry.subagentCount)")
                            .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(subagents, id: \.key) { member in
                            SessionRow(session: member.session, sessionKey: member.key,
                                       maximum: detailMaximum, now: now)
                        }
                    }
                }
            }
        }
    }

    private var metrics: some View {
        VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing,
               spacing: DesignTokens.rowLineSpacing) {
            Text(MetricFormatter.exactTokens(entry.tokens ?? 0)).font(DesignTokens.rowValue)
            if let cost = entry.cost {
                Text(MetricFormatter.compactUsageCost(cost, unpricedTokens: entry.unpricedTokens,
                                                      currency: preferences.currency))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .monospacedDigit().fixedSize(horizontal: true, vertical: false)
    }
}
