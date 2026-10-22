//! 连接可靠性策略：SSH 自动重连（指数退避 + 最大重试）与心跳保活。
//!
//! 纯逻辑、零 I/O 依赖，便于单元测试与在会话管理层直接复用。
//! 对应需求 R-04（SSH 自动重连 + 心跳保活），并规避风险 RK-07（无限重连刷屏）。

use std::time::Duration;

/// 自动重连退避策略。
///
/// - `base_delay`：首次重连等待
/// - `max_delay`：单次等待上限（防止退避爆炸）
/// - `factor`：退避倍数（>=1）
/// - `max_attempts`：最大重试次数（0 表示不限制，但建议显式设置以规避 RK-07）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconnectPolicy {
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub factor: u32,
    pub max_attempts: u32,
}

impl ReconnectPolicy {
    pub fn new(base_delay: Duration, max_delay: Duration, factor: u32, max_attempts: u32) -> Self {
        ReconnectPolicy {
            base_delay,
            max_delay,
            factor: factor.max(1),
            max_attempts,
        }
    }

    /// 给定「已尝试次数」`attempt`（从 0 计），返回下一次应等待的时长。
    /// 返回 `None` 表示已达到最大重试次数，调用方应停止重连（避免无限重连刷屏，RK-07）。
    pub fn next_delay(&self, attempt: u32) -> Option<Duration> {
        if self.max_attempts > 0 && attempt >= self.max_attempts {
            return None;
        }
        let exp = self.factor.saturating_pow(attempt);
        let scaled = self.base_delay.checked_mul(exp).unwrap_or(self.max_delay);
        Some(scaled.min(self.max_delay))
    }

    /// 对退避时长施加抖动（区间 [0.5, 1.0] * delay），缓解多连接同时重连的惊群效应。
    /// `rng` 应为 [0,1) 的伪随机值，便于测试确定性。
    pub fn with_jitter(&self, delay: Duration, rng: f64) -> Duration {
        let r = if rng < 0.0 { 0.0 } else if rng >= 1.0 { 0.999999 } else { rng };
        let factor = 0.5 + r * 0.5;
        let ms = (delay.as_millis() as f64 * factor).max(0.0);
        Duration::from_millis(ms as u64)
    }
}

/// 心跳保活策略：连接空闲超过 `interval` 时发送一次心跳，避免被中间设备掐断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeepAlivePolicy {
    pub interval: Duration,
}

impl KeepAlivePolicy {
    pub fn new(interval: Duration) -> Self {
        KeepAlivePolicy { interval }
    }

    /// `now` 与 `last_io` 为单调时钟读数（如 `Instant::now().elapsed()`）。
    /// 当空闲时长 >= interval 时应发送心跳。
    pub fn should_send(&self, now: Duration, last_io: Duration) -> bool {
        now.saturating_sub(last_io) >= self.interval
    }

    /// 距离下次心跳还需等待的时长（已过期则返回 0）。
    pub fn remaining(&self, now: Duration, last_io: Duration) -> Duration {
        let idle = now.saturating_sub(last_io);
        self.interval.saturating_sub(idle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p0_first_delay_is_base() {
        let p = ReconnectPolicy::new(Duration::from_secs(1), Duration::from_secs(30), 2, 5);
        assert_eq!(p.next_delay(0), Some(Duration::from_secs(1)));
    }

    #[test]
    fn p1_exponential_growth_capped() {
        // max_attempts 设大，专门验证退避增长与上限截断
        let p = ReconnectPolicy::new(Duration::from_secs(1), Duration::from_secs(30), 2, 20);
        assert_eq!(p.next_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(p.next_delay(1), Some(Duration::from_secs(2)));
        assert_eq!(p.next_delay(2), Some(Duration::from_secs(4)));
        assert_eq!(p.next_delay(3), Some(Duration::from_secs(8)));
        // 超过 max_delay 后被截断
        assert_eq!(p.next_delay(8), Some(Duration::from_secs(30)));
    }

    #[test]
    fn p2_max_attempts_stops_reconnect() {
        let p = ReconnectPolicy::new(Duration::from_secs(1), Duration::from_secs(30), 2, 3);
        assert_eq!(p.next_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(p.next_delay(1), Some(Duration::from_secs(2)));
        assert_eq!(p.next_delay(2), Some(Duration::from_secs(4)));
        // 第 3 次（attempt == max_attempts）应停止
        assert_eq!(p.next_delay(3), None);
        assert_eq!(p.next_delay(100), None);
    }

    #[test]
    fn p3_factor_one_is_constant() {
        let p = ReconnectPolicy::new(Duration::from_secs(5), Duration::from_secs(30), 1, 4);
        assert_eq!(p.next_delay(0), Some(Duration::from_secs(5)));
        assert_eq!(p.next_delay(1), Some(Duration::from_secs(5)));
        assert_eq!(p.next_delay(3), Some(Duration::from_secs(5)));
        assert_eq!(p.next_delay(4), None);
    }

    #[test]
    fn p4_jitter_bounds() {
        let p = ReconnectPolicy::new(Duration::from_millis(1000), Duration::from_millis(1000), 1, 1);
        let d = Duration::from_millis(1000);
        // rng=0 => 50%，rng→1 => 100%
        let lo = p.with_jitter(d, 0.0);
        let hi = p.with_jitter(d, 0.999);
        assert_eq!(lo, Duration::from_millis(500));
        assert!(hi <= d);
        assert!(hi >= lo);
        // 越界 rng 被夹紧
        assert_eq!(p.with_jitter(d, -5.0), Duration::from_millis(500));
        assert!(p.with_jitter(d, 5.0) <= d);
    }

    #[test]
    fn p5_edge_no_overflow_zero_base() {
        // max_attempts=0（不限制）下，极大 attempt 不应溢出 / panic，应截断到 max_delay
        let p = ReconnectPolicy::new(Duration::from_secs(1), Duration::from_secs(10), 3, 0);
        assert_eq!(p.next_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(p.next_delay(u32::MAX), Some(Duration::from_secs(10)));
    }

    #[test]
    fn keepalive_idle_triggers() {
        let k = KeepAlivePolicy::new(Duration::from_secs(15));
        let base = Duration::from_secs(0);
        // 刚有活动不应发送
        assert!(!k.should_send(Duration::from_secs(5), base));
        // 空闲达到阈值应发送
        assert!(k.should_send(Duration::from_secs(15), base));
        assert!(k.should_send(Duration::from_secs(60), base));
        // 剩余时间倒推
        assert_eq!(k.remaining(Duration::from_secs(5), base), Duration::from_secs(10));
        assert_eq!(k.remaining(Duration::from_secs(20), base), Duration::from_secs(0));
    }

    #[test]
    fn keepalive_zero_interval_always() {
        let k = KeepAlivePolicy::new(Duration::from_secs(0));
        assert!(k.should_send(Duration::from_secs(0), Duration::from_secs(0)));
        assert_eq!(k.remaining(Duration::from_secs(0), Duration::from_secs(0)), Duration::from_secs(0));
    }
}
