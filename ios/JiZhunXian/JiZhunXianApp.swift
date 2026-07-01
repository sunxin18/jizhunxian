import Charts
import Security
import SwiftUI
import UIKit

@main
struct JiZhunXianApp: App {
    @StateObject private var store = FundStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .task {
                    await store.bootstrap()
                }
        }
    }
}

struct AppState: Codable {
    var funds: [String]
    var holdings: [String: Double]
    var alerts: [AlertRule]
    var sort: SortMode

    static let sample = AppState(
        funds: ["161725", "110022", "005827", "003096"],
        holdings: ["161725": 12000, "110022": 8000, "005827": 10000, "003096": 6000],
        alerts: [],
        sort: .custom
    )
}

struct AlertRule: Codable, Identifiable, Equatable {
    var id = UUID()
    var code: String
    var type: AlertType
    var value: Double

    enum CodingKeys: String, CodingKey {
        case code
        case type
        case value
    }
}

enum AlertType: String, Codable, CaseIterable, Identifiable {
    case up
    case down

    var id: String { rawValue }
    var title: String { self == .up ? "涨幅超过" : "跌幅超过" }
}

enum SortMode: String, Codable, CaseIterable, Identifiable {
    case custom
    case change
    case profit
    case name

    var id: String { rawValue }

    var title: String {
        switch self {
        case .custom: "自选"
        case .change: "涨跌"
        case .profit: "收益"
        case .name: "名称"
        }
    }
}

struct FundQuote: Codable, Identifiable, Equatable {
    var code: String
    var name: String
    var nav: Double?
    var quote: Double?
    var change: Double?
    var navDate: String
    var quoteTime: String
    var live: Bool

    var id: String { code }
}

struct HistoryPoint: Codable, Identifiable, Equatable {
    var date: String
    var nav: Double?
    var accumulative: Double?
    var change: Double?
    var type: String?

    var id: String { date }
}

struct User: Codable, Equatable {
    var id: String
    var name: String
    var phone: String?
    var email: String?
    var accountType: String
    var createdAt: String
    var token: String?
}

struct QuoteRow: Identifiable, Equatable {
    var quote: FundQuote
    var holding: Double
    var profit: Double?
    var index: Int

    var id: String { quote.code }
}

struct APIError: Decodable {
    var error: String?
    var message: String?
}

struct QuotesResponse: Decodable {
    var quotes: [FundQuote]
}

struct HistoryResponse: Decodable {
    var history: [HistoryPoint]
}

struct MeResponse: Decodable {
    var user: User
    var state: AppState
}

struct LoginResponse: Decodable {
    var user: User
    var state: AppState
    var isNewUser: Bool
}

struct StateResponse: Decodable {
    var state: AppState
}

final class KeychainStore {
    private let service = "cc.jizhunxian.ios"

    func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    func write(_ value: String, for key: String) {
        delete(key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: Data(value.utf8)
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }
}

final class APIClient {
    var baseURL = URL(string: "http://152.136.167.101:8080")!
    var token: String?

    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(session: URLSession = .shared) {
        self.session = session
    }

    func quotes(codes: [String]) async throws -> [FundQuote] {
        guard !codes.isEmpty else { return [] }
        var components = URLComponents(url: baseURL.appending(path: "/api/funds/quotes"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "codes", value: codes.joined(separator: ","))]
        return try await send(components.url!, method: "GET", body: Optional<Data>.none, as: QuotesResponse.self).quotes
    }

    func history(code: String, size: Int) async throws -> [HistoryPoint] {
        var components = URLComponents(url: baseURL.appending(path: "/api/funds/history"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "size", value: String(size))
        ]
        return try await send(components.url!, method: "GET", body: Optional<Data>.none, as: HistoryResponse.self).history
    }

    func me() async throws -> MeResponse {
        try await send(baseURL.appending(path: "/api/me"), method: "GET", body: Optional<Data>.none, as: MeResponse.self)
    }

    func saveState(_ state: AppState) async throws -> AppState {
        let body = try encoder.encode(["state": state])
        return try await send(baseURL.appending(path: "/api/state"), method: "POST", body: body, as: StateResponse.self).state
    }

    func sendEmailCode(email: String) async throws {
        let body = try encoder.encode(["email": email])
        let _: EmptyResponse = try await send(baseURL.appending(path: "/api/email-code"), method: "POST", body: body, as: EmptyResponse.self)
    }

    func emailLogin(name: String, email: String, code: String) async throws -> LoginResponse {
        let body = try encoder.encode(["name": name, "email": email, "code": code])
        return try await send(baseURL.appending(path: "/api/email-login"), method: "POST", body: body, as: LoginResponse.self)
    }

    func logout() async {
        guard token != nil else { return }
        let url = baseURL.appending(path: "/api/logout")
        let _: EmptyResponse? = try? await send(url, method: "POST", body: Data("{}".utf8), as: EmptyResponse.self)
    }

    private func send<T: Decodable>(_ url: URL, method: String, body: Data?, as type: T.Type) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        if !(200..<300).contains(http.statusCode) {
            if let apiError = try? decoder.decode(APIError.self, from: data), let message = apiError.message {
                throw NSError(domain: "JiZhunXianAPI", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: message])
            }
            throw NSError(domain: "JiZhunXianAPI", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "服务暂不可用"])
        }
        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }
        return try decoder.decode(T.self, from: data)
    }
}

struct EmptyResponse: Decodable {}

@MainActor
final class FundStore: ObservableObject {
    @Published var state = AppState.sample
    @Published var quotes: [String: FundQuote] = [:]
    @Published var user: User?
    @Published var isRefreshing = false
    @Published var status = "等待刷新"
    @Published var errorMessage: String?

    private let api = APIClient()
    private let keychain = KeychainStore()
    private let storageKey = "jizhunxian.ios.state"
    private let tokenKey = "token"

    var rows: [QuoteRow] {
        let mapped = state.funds.enumerated().map { index, code in
            let quote = quotes[code] ?? FundQuote(
                code: code,
                name: Self.defaultName(code),
                nav: nil,
                quote: nil,
                change: nil,
                navDate: "--",
                quoteTime: "等待刷新",
                live: false
            )
            let holding = state.holdings[code] ?? 0
            let profit = quote.change.map { holding * $0 / 100 }
            return QuoteRow(quote: quote, holding: holding, profit: profit, index: index)
        }
        switch state.sort {
        case .custom:
            return mapped.sorted { $0.index < $1.index }
        case .change:
            return mapped.sorted { ($0.quote.change ?? -999) > ($1.quote.change ?? -999) }
        case .profit:
            return mapped.sorted { ($0.profit ?? -Double.greatestFiniteMagnitude) > ($1.profit ?? -Double.greatestFiniteMagnitude) }
        case .name:
            return mapped.sorted { $0.quote.name.localizedCompare($1.quote.name) == .orderedAscending }
        }
    }

    var totalHolding: Double {
        rows.reduce(0) { $0 + $1.holding }
    }

    var todayProfit: Double {
        rows.reduce(0) { $0 + ($1.profit ?? 0) }
    }

    var averageChange: Double? {
        let values = rows.compactMap(\.quote.change)
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    var riskLabel: String {
        let biggest = rows.map(\.holding).max() ?? 0
        let concentration = totalHolding > 0 ? biggest / totalHolding : 0
        let volatility = rows.compactMap(\.quote.change).map(abs).max() ?? 0
        let score = concentration * 50 + volatility * 12
        if score >= 55 { return "偏高" }
        if score >= 30 { return "中性" }
        return "稳健"
    }

    func bootstrap() async {
        loadLocalState()
        if let token = keychain.read(tokenKey) {
            api.token = token
            await hydrateAccount()
        }
        await refreshQuotes()
    }

    func refreshQuotes() async {
        guard !state.funds.isEmpty else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let fresh = try await api.quotes(codes: state.funds)
            quotes = Dictionary(uniqueKeysWithValues: fresh.map { ($0.code, $0) })
            status = "已刷新 \(Self.timeFormatter.string(from: Date()))"
        } catch {
            errorMessage = error.localizedDescription
            status = "刷新失败"
        }
    }

    func history(code: String, size: Int) async throws -> [HistoryPoint] {
        try await api.history(code: code, size: size)
    }

    func addFund(_ raw: String) {
        let code = raw.filter(\.isNumber).prefix(6)
        guard code.count == 6 else {
            errorMessage = "请输入 6 位基金代码"
            return
        }
        let value = String(code)
        guard !state.funds.contains(value) else {
            errorMessage = "\(value) 已在自选"
            return
        }
        state.funds.append(value)
        state.holdings[value] = 0
        persistAndSync()
        Task { await refreshQuotes() }
    }

    func removeFund(_ code: String) {
        state.funds.removeAll { $0 == code }
        state.holdings.removeValue(forKey: code)
        state.alerts.removeAll { $0.code == code }
        quotes.removeValue(forKey: code)
        persistAndSync()
    }

    func updateHolding(code: String, amount: Double) {
        state.holdings[code] = max(0, amount)
        persistAndSync()
    }

    func saveStateChange() {
        persistAndSync()
    }

    func addAlert(code: String, type: AlertType, value: Double) {
        guard value > 0 else {
            errorMessage = "提醒阈值需要大于 0"
            return
        }
        state.alerts.append(AlertRule(code: code, type: type, value: value))
        persistAndSync()
    }

    func removeAlert(_ alert: AlertRule) {
        state.alerts.removeAll { $0 == alert }
        persistAndSync()
    }

    func sendEmailCode(email: String) async {
        do {
            try await api.sendEmailCode(email: email)
            status = "验证码已发送"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(name: String, email: String, code: String) async {
        do {
            let response = try await api.emailLogin(name: name, email: email, code: code)
            user = response.user
            api.token = response.user.token
            if let token = response.user.token {
                keychain.write(token, for: tokenKey)
            }
            if response.isNewUser {
                persistAndSync()
            } else {
                state = response.state
                saveLocalState()
            }
            status = response.isNewUser ? "账号已创建" : "欢迎回来"
            await refreshQuotes()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() {
        let oldAPI = api
        Task { await oldAPI.logout() }
        keychain.delete(tokenKey)
        api.token = nil
        user = nil
        status = "已退出账号"
    }

    private func hydrateAccount() async {
        do {
            let response = try await api.me()
            user = response.user
            state = response.state
            saveLocalState()
        } catch {
            keychain.delete(tokenKey)
            api.token = nil
        }
    }

    private func persistAndSync() {
        saveLocalState()
        guard api.token != nil else { return }
        let next = state
        Task {
            do {
                _ = try await api.saveState(next)
            } catch {
                await MainActor.run {
                    self.errorMessage = "本地已保存，云端稍后同步"
                }
            }
        }
    }

    private func loadLocalState() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let saved = try? JSONDecoder().decode(AppState.self, from: data) else {
            return
        }
        state = saved
    }

    private func saveLocalState() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    static func defaultName(_ code: String) -> String {
        [
            "161725": "招商中证白酒指数A",
            "110022": "易方达消费行业股票",
            "005827": "易方达蓝筹精选混合",
            "003096": "中欧医疗健康混合A",
            "320007": "诺安成长混合",
            "000001": "华夏成长混合",
            "002001": "华夏回报混合A",
            "260108": "景顺长城新兴成长混合A"
        ][code] ?? "基金 \(code)"
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}

struct ContentView: View {
    @EnvironmentObject private var store: FundStore

    var body: some View {
        TabView {
            WatchlistView()
                .tabItem { Label("看盘", systemImage: "bolt.fill") }
            PortfolioView()
                .tabItem { Label("持仓", systemImage: "list.bullet.rectangle") }
            AlertsView()
                .tabItem { Label("提醒", systemImage: "bell.badge") }
            AccountView()
                .tabItem { Label("账号", systemImage: "person.crop.circle") }
        }
        .tint(.accentColor)
        .alert("提示", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("知道了", role: .cancel) { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "")
        }
    }
}

struct WatchlistView: View {
    @EnvironmentObject private var store: FundStore
    @State private var newCode = ""
    @State private var selectedQuote: FundQuote?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    DashboardHeader()
                    addFundBar
                    sortPicker
                    LazyVStack(spacing: 10) {
                        ForEach(store.rows) { row in
                            FundRowCard(row: row)
                                .onTapGesture { selectedQuote = row.quote }
                        }
                    }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("基准线")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await store.refreshQuotes() }
                    } label: {
                        Image(systemName: store.isRefreshing ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                    }
                }
            }
            .sheet(item: $selectedQuote) { quote in
                FundDetailView(quote: quote)
            }
        }
    }

    private var addFundBar: some View {
        HStack {
            TextField("输入 6 位基金代码", text: $newCode)
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)
            Button {
                store.addFund(newCode)
                newCode = ""
            } label: {
                Label("添加", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var sortPicker: some View {
        Picker("排序", selection: $store.state.sort) {
            ForEach(SortMode.allCases) { mode in
                Text(mode.title).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .onChange(of: store.state.sort) {
            store.saveStateChange()
        }
    }
}

struct DashboardHeader: View {
    @EnvironmentObject private var store: FundStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("A 股基金实时观察台")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("今日看盘")
                        .font(.largeTitle.bold())
                }
                Spacer()
                Text(store.status)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(.thinMaterial, in: Capsule())
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 2), spacing: 10) {
                MetricTile(title: "自选基金", value: "\(store.rows.count)", subtitle: "只基金正在跟踪")
                MetricTile(title: "平均估值", value: percent(store.averageChange), subtitle: "按当前估算涨跌幅", tint: trendColor(store.averageChange))
                MetricTile(title: "今日预估盈亏", value: currency(store.todayProfit), subtitle: "基于已录入持仓", tint: trendColor(store.todayProfit))
                MetricTile(title: "风险温度", value: store.riskLabel, subtitle: "波动与持仓集中度")
            }
        }
    }
}

struct MetricTile: View {
    var title: String
    var value: String
    var subtitle: String
    var tint: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.monospacedDigit().bold())
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct FundRowCard: View {
    @EnvironmentObject private var store: FundStore
    var row: QuoteRow

    var body: some View {
        VStack(spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.quote.name)
                        .font(.headline)
                    Text("\(row.quote.code) · \(row.quote.live ? "实时估值" : "离线缓存")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(row.quote.quote.map { String(format: "%.4f", $0) } ?? "--")
                        .font(.title3.monospacedDigit().bold())
                    Text(percent(row.quote.change))
                        .font(.callout.monospacedDigit().bold())
                        .foregroundStyle(trendColor(row.quote.change))
                }
            }
            HStack {
                Label(row.quote.nav.map { String(format: "%.4f", $0) } ?? "--", systemImage: "calendar")
                Spacer()
                Label(row.holding > 0 ? currency(row.profit ?? 0) : "--", systemImage: "yensign.circle")
                    .foregroundStyle(trendColor(row.profit))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        .swipeActions {
            Button(role: .destructive) {
                store.removeFund(row.quote.code)
            } label: {
                Label("移除", systemImage: "trash")
            }
        }
    }
}

struct FundDetailView: View {
    @EnvironmentObject private var store: FundStore
    var quote: FundQuote
    @State private var range = 30
    @State private var points: [HistoryPoint] = []
    @State private var isLoading = true

    private let ranges = [7, 30, 90, 180, 365]

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                rangePicker

                if isLoading {
                    ProgressView("正在加载历史波动")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if points.isEmpty {
                    ContentUnavailableView("暂无历史数据", systemImage: "chart.xyaxis.line", description: Text("稍后再试或切换区间"))
                } else {
                    historyChart
                    historyList
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(quote.name)
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            points = try await store.history(code: quote.code, size: range)
        } catch {
            store.errorMessage = error.localizedDescription
            points = []
        }
    }

    private var rangePicker: some View {
        Picker("区间", selection: $range) {
            ForEach(ranges, id: \.self) { value in
                Text(value == 365 ? "1年" : "\(value)日").tag(value)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        .onChange(of: range) {
            Task { await load() }
        }
    }

    private var chartPoints: [HistoryPoint] {
        points.filter { $0.nav != nil }
    }

    private var historyChart: some View {
        Chart(chartPoints) { point in
            LineMark(
                x: .value("日期", point.date),
                y: .value("净值", point.nav ?? 0)
            )
            .foregroundStyle(Color.accentColor)

            AreaMark(
                x: .value("日期", point.date),
                y: .value("净值", point.nav ?? 0)
            )
            .foregroundStyle(Color.accentColor.opacity(0.12))
        }
        .chartXAxis(.hidden)
        .frame(height: 260)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal)
    }

    private var historyList: some View {
        List(points.reversed()) { point in
            HistoryPointRow(point: point)
        }
        .listStyle(.plain)
    }
}

struct HistoryPointRow: View {
    let point: HistoryPoint

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(point.date)
                Text(point.type ?? "净值")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing) {
                Text(point.nav.map { String(format: "%.4f", $0) } ?? "--")
                    .font(.body.monospacedDigit().bold())
                Text(percent(point.change))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(trendColor(point.change))
            }
        }
    }
}

struct PortfolioView: View {
    @EnvironmentObject private var store: FundStore

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.rows) { row in
                    HoldingEditor(row: row)
                }
            }
            .navigationTitle("组合持仓")
            .overlay {
                if store.rows.isEmpty {
                    ContentUnavailableView("还没有自选基金", systemImage: "tray", description: Text("先在看盘页添加基金"))
                }
            }
        }
    }
}

struct HoldingEditor: View {
    @EnvironmentObject private var store: FundStore
    var row: QuoteRow
    @State private var amountText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading) {
                    Text(row.quote.name)
                        .font(.headline)
                    Text(row.quote.code)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(row.profit.map(currency) ?? "--")
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(trendColor(row.profit))
            }
            TextField("持仓金额", text: $amountText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
        }
        .padding(.vertical, 6)
        .onAppear {
            amountText = row.holding > 0 ? String(format: "%.2f", row.holding) : ""
        }
        .onChange(of: amountText) {
            save()
        }
    }

    private func save() {
        store.updateHolding(code: row.quote.code, amount: Double(amountText) ?? 0)
    }
}

struct AlertsView: View {
    @EnvironmentObject private var store: FundStore
    @State private var selectedCode = ""
    @State private var type: AlertType = .up
    @State private var threshold = "2"

    var body: some View {
        NavigationStack {
            List {
                Section("新增提醒") {
                    Picker("基金", selection: $selectedCode) {
                        ForEach(store.state.funds, id: \.self) { code in
                            Text("\(code) \(store.quotes[code]?.name ?? FundStore.defaultName(code))").tag(code)
                        }
                    }
                    Picker("条件", selection: $type) {
                        ForEach(AlertType.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    TextField("阈值百分比", text: $threshold)
                        .keyboardType(.decimalPad)
                    Button {
                        let code = selectedCode.isEmpty ? (store.state.funds.first ?? "") : selectedCode
                        store.addAlert(code: code, type: type, value: Double(threshold) ?? 0)
                    } label: {
                        Label("保存提醒", systemImage: "bell.badge")
                    }
                }

                Section("规则") {
                    ForEach(store.state.alerts) { alert in
                        let quote = store.quotes[alert.code]
                        let current = quote?.change ?? 0
                        let hit = alert.type == .up ? current >= alert.value : current <= -alert.value
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(quote?.name ?? FundStore.defaultName(alert.code))
                                    .font(.headline)
                                Text("\(alert.type.title) \(String(format: "%.2f", alert.value))%")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(hit ? "已触发" : "监控中")
                                .font(.callout.bold())
                                .foregroundStyle(hit ? .orange : .secondary)
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                store.removeAlert(alert)
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .navigationTitle("智能提醒")
            .onAppear {
                selectedCode = selectedCode.isEmpty ? (store.state.funds.first ?? "") : selectedCode
            }
        }
    }
}

struct AccountView: View {
    @EnvironmentObject private var store: FundStore
    @State private var name = ""
    @State private var email = ""
    @State private var code = ""
    @State private var isSending = false
    @State private var isLoggingIn = false

    var body: some View {
        NavigationStack {
            Form {
                if let user = store.user {
                    Section("当前账号") {
                        LabeledContent("昵称", value: user.name)
                        LabeledContent("邮箱", value: user.email ?? "--")
                        LabeledContent("账号类型", value: user.accountType == "email" ? "邮箱账号" : "云端账号")
                        Button(role: .destructive) {
                            store.logout()
                        } label: {
                            Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
                } else {
                    Section("登录或创建账号") {
                        TextField("昵称", text: $name)
                        TextField("邮箱", text: $email)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                        HStack {
                            TextField("6 位验证码", text: $code)
                                .keyboardType(.numberPad)
                            Button(isSending ? "发送中" : "获取验证码") {
                                isSending = true
                                Task {
                                    await store.sendEmailCode(email: email)
                                    isSending = false
                                }
                            }
                            .disabled(isSending || email.isEmpty)
                        }
                        Button {
                            isLoggingIn = true
                            Task {
                                await store.login(name: name.isEmpty ? "养基用户" : name, email: email, code: code)
                                isLoggingIn = false
                            }
                        } label: {
                            Label(isLoggingIn ? "登录中" : "登录 / 创建账号", systemImage: "person.crop.circle.badge.checkmark")
                        }
                        .disabled(isLoggingIn || email.isEmpty || code.count < 6)
                    }
                    Section {
                        Text("验证码 10 分钟内有效。登录后会同步自选、持仓和提醒。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("服务") {
                    LabeledContent("API", value: "152.136.167.101:8080")
                    Text("正式上架前建议切换到 HTTPS 域名，并关闭开发期 HTTP 例外。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("账号")
        }
    }
}

func trendColor(_ value: Double?) -> Color {
    guard let value else { return .secondary }
    if value > 0 { return .red }
    if value < 0 { return .green }
    return .secondary
}

func percent(_ value: Double?) -> String {
    guard let value else { return "--" }
    return "\(value > 0 ? "+" : "")\(String(format: "%.2f", value))%"
}

func currency(_ value: Double) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "CNY"
    formatter.maximumFractionDigits = 2
    return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
}
