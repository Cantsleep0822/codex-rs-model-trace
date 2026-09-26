//! 回答文本的数字序列提取：与 ModelTrace `parseNumbers` 语义一致。
//! 连续数字段之间若被字母分隔则断段；范围外数字不计入但也不打断段落；
//! 最终取最长的一段，避免说明文字中的零散数字污染序列。

const VALUE_MIN: u32 = 1;
const VALUE_MAX: u32 = 355;

pub fn parse_numbers(text: &str) -> Vec<u32> {
    let mut runs: Vec<Vec<u32>> = Vec::new();
    let mut current: Vec<u32> = Vec::new();
    let mut previous_end = 0usize;
    let mut index = 0usize;
    while index < text.len() {
        let byte = text.as_bytes()[index];
        if byte.is_ascii_digit() {
            let start = index;
            while index < text.len() && text.as_bytes()[index].is_ascii_digit() {
                index += 1;
            }
            let value: u64 = text[start..index].parse().unwrap_or(u64::MAX);
            let separator = &text[previous_end..start];
            if !current.is_empty() && separator.chars().any(char::is_alphabetic) {
                runs.push(std::mem::take(&mut current));
            }
            if (u64::from(VALUE_MIN)..=u64::from(VALUE_MAX)).contains(&value) {
                current.push(value as u32);
            }
            previous_end = index;
        } else {
            index += text[index..]
                .chars()
                .next()
                .map(char::len_utf8)
                .unwrap_or(1);
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs.into_iter().max_by_key(Vec::len).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::parse_numbers;

    #[test]
    fn takes_longest_run_and_splits_on_letters() {
        let text = "说明 1 2 3，然后输出：10, 20, 30, 40, 5, 6, 7, 8, 9, 10 结束。";
        let numbers = parse_numbers(text);
        assert_eq!(numbers, vec![10, 20, 30, 40, 5, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn out_of_range_keeps_run() {
        let numbers = parse_numbers("7 8 999 9 10");
        assert_eq!(numbers, vec![7, 8, 9, 10]);
    }
}
