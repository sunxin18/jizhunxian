# 基准线 iOS

这是基准线的 SwiftUI 原生 iOS MVP，入口工程：

```text
ios/JiZhunXian.xcodeproj
```

## 当前能力

- 看盘：自选基金、实时估值、平均涨跌、今日预估盈亏和风险温度。
- 详情：基金 7 日、30 日、90 日、180 日、1 年历史净值走势。
- 持仓：录入每只基金持仓金额，自动估算今日盈亏。
- 提醒：新增、查看、删除涨跌幅提醒规则。
- 账号：邮箱验证码登录，登录后同步自选、持仓和提醒。

## 后端依赖

开发版默认连接：

```text
http://152.136.167.101:8080
```

iOS 使用以下接口：

- `GET /api/funds/quotes?codes=161725,110022`
- `GET /api/funds/history?code=161725&size=30`
- `POST /api/email-code`
- `POST /api/email-login`
- `GET /api/me`
- `POST /api/state`
- `POST /api/logout`

## 打开方式

1. 安装完整 Xcode。
2. 打开 `ios/JiZhunXian.xcodeproj`。
3. 在 Signing & Capabilities 里选择你的 Apple Team。
4. 选择 iPhone 模拟器运行。

## 上架前必须处理

- 把 API 切到 HTTPS 域名。
- 删除 `Info.plist` 里的开发期 HTTP 例外。
- 配置正式 App Icon。
- 准备隐私政策、用户协议、数据来源说明和投资风险提示。
- 接入 TestFlight 后再邀请用户试用。
