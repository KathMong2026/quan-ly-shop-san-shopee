# Kho Shopee — app quản lý shop sàn Shopee (mã nguồn mở)

Web app quản lý **kho hàng, đơn hàng, combo và lợi nhuận** cho shop bán trên Shopee. Kết nối thẳng vào **Shopee Open Platform API**: tự kéo đơn, tự trừ kho, tự đẩy số tồn lên Shopee, sao lưu kho mỗi đêm.

- 🆓 Chạy miễn phí trên gói free của **Supabase** (dữ liệu + máy chủ) và **Vercel** (giao diện).
- 🔒 Dữ liệu nằm trong Supabase **của riêng bạn** — không ai khác đọc được.
- 📱 Dùng được trên điện thoại (cài như app — PWA).
- ⚖️ Giấy phép MIT: tự do dùng, sửa, chia sẻ.

> Đây **không phải** sản phẩm chính thức của Shopee. Bạn cần tự đăng ký tài khoản nhà phát triển ở Shopee Open Platform.

## Tính năng chính

| Nhóm | Có gì |
|---|---|
| Kết nối Shopee | Màn hình 3 bước: nhập Partner ID/Key → cấp quyền shop → lấy sản phẩm & tồn về. Token tự gia hạn. |
| Đơn hàng | Tự kéo đơn mỗi 20 phút (kể cả khi tắt app), nhận webhook, trừ kho chống trừ 2 lần, đơn huỷ tự cộng lại. |
| Kho | **Hàng gốc** (tồn thật) tách khỏi **listing** trên sàn; **công thức combo** (1 listing ăn nhiều hàng gốc, hoặc nhiều listing dùng chung 1 hàng gốc). Nhập / xuất / kiểm kê, xuất-nhập-tồn theo tháng, ngưỡng sắp hết. |
| Nhập hàng | Phiếu nhập, nhà cung cấp, giá vốn. |
| Hàng hoàn | Kéo yêu cầu trả hàng, đối soát hàng về kho. |
| Báo cáo | Doanh thu thực nhận sau phí sàn, lợi nhuận theo giá vốn, bán theo sản phẩm, chi phí quảng cáo. |
| An toàn | Sao lưu kho tự động mỗi đêm (so với tồn trên Shopee), khôi phục 1 bấm. Giá vốn **không bao giờ** gửi lên Shopee. |

## Cấu trúc thư mục

```
web/                          giao diện (1 file HTML, không cần build)
  index.html  config.js  sw.js  manifest.webmanifest  icons/
supabase/
  install.sql                 1 file cài cơ sở dữ liệu (bảng, hàm, bảo mật, lịch chạy tự động)
  functions/kho-shopee/index.ts   máy chủ nói chuyện với Shopee API
```

---

## Cài đặt (khoảng 20–30 phút, không cần biết lập trình)

### Bước 0 — Chuẩn bị
1. Tài khoản **Supabase**: https://supabase.com (đăng nhập bằng GitHub/Google, miễn phí).
2. Tài khoản **Shopee Open Platform**: https://open.shopee.com → đăng ký nhà phát triển → **App Management › Create App**, loại **ERP System** (hoặc *Seller In-house System*). Shopee duyệt app xong bạn có **Partner ID** và **Partner Key** (bản *Test* dùng ngay được, bản *Live* sau khi Shopee duyệt).
   - Quyền API cần bật cho app: Shop, Product, Order, Logistics, Payment, Returns (Seller Chat nếu muốn xem chat).
3. (Để đưa giao diện lên mạng) tài khoản **Vercel**: https://vercel.com — miễn phí.

### Bước 1 — Tạo project Supabase
Supabase Dashboard → **New project** → đặt tên (vd `kho-shopee`), đặt mật khẩu DB (cất kỹ), chọn vùng **Singapore** hoặc **Tokyo** → **Create**. Chờ 1–2 phút.

### Bước 2 — Cài cơ sở dữ liệu
Trong project: **SQL Editor › New query** → mở file [`supabase/install.sql`](supabase/install.sql), chép **toàn bộ** dán vào → **Run**.
Thấy dòng `Cài đặt xong!` là được. (Chạy lại nhiều lần không sao, không mất dữ liệu.)

### Bước 3 — Deploy máy chủ `kho-shopee`
**Cách A — trên web (dễ nhất):**
1. Supabase › **Edge Functions › Deploy a new function › Via Editor**.
2. Tên function: **`kho-shopee`** (đúng y chữ này).
3. Xoá mã mẫu, dán toàn bộ nội dung file [`supabase/functions/kho-shopee/index.ts`](supabase/functions/kho-shopee/index.ts) → **Deploy**.
4. Vào function vừa tạo › **Details / Settings** → **TẮT** "Enforce JWT Verification" (Verify JWT) → Save.
   *(Bắt buộc: Shopee gọi ngược về máy chủ không kèm mã đăng nhập. Máy chủ tự kiểm quyền chủ shop bên trong.)*

**Cách B — dòng lệnh** (cần Node.js), chạy ở thư mục gốc repo:
```bash
npx supabase login
npx supabase functions deploy kho-shopee --no-verify-jwt --project-ref <MÃ_PROJECT>
```
`<MÃ_PROJECT>` là đoạn chữ trong địa chỉ `https://<MÃ_PROJECT>.supabase.co`.

### Bước 4 — Đưa giao diện lên mạng
**Vercel (khuyên dùng):** Fork repo này về GitHub của bạn → Vercel › **Add New › Project** → chọn repo → **Root Directory: `web`** → Deploy. Bạn được địa chỉ dạng `https://ten-cua-ban.vercel.app`.

Cách khác: Netlify / Cloudflare Pages (thư mục xuất bản = `web`), hoặc chạy thử trên máy: `npx serve web` rồi mở http://localhost:3000.

### Bước 5 — Mở app lần đầu
1. Mở địa chỉ app → màn **Cài đặt lần đầu** → dán **Project URL** và **Publishable key** (Supabase › nút **Connect** hoặc **Project Settings › API Keys**). ⛔ Không dán *secret / service_role key*.
   *(Muốn khỏi nhập trên từng máy: điền 2 giá trị này vào `web/config.js` rồi deploy lại.)*
2. Màn đăng nhập → nhập email + mật khẩu → bấm **Tạo tài khoản chủ shop**.
   - Supabase mặc định bắt xác nhận email: mở email bấm link rồi quay lại đăng nhập. Muốn bỏ bước này: Supabase › **Authentication › Sign In / Providers › Email** → tắt **Confirm email**.
   - Hoặc tạo tài khoản ở Supabase › **Authentication › Users › Add user** (tick *Auto confirm*), rồi đăng nhập ở app.
   - **Tài khoản đăng nhập đầu tiên = chủ shop.** Chỉ chủ shop xem/sửa được dữ liệu.
3. 🔒 Tạo xong tài khoản, nên **tắt đăng ký mới**: Supabase › Authentication › Sign In / Providers › tắt **Allow new users to sign up**.

### Bước 6 — Kết nối Shopee (trong app, màn **Kết nối Shopee**)
1. **Bước 1 trên màn hình:** nhập Partner ID, Partner Key, chọn *Shop thật (Live)* hoặc *Thử nghiệm* → **Lưu thông tin**.
   Màn hình hiện 2 địa chỉ cần điền vào app của bạn trên Shopee Open Platform:
   - **Redirect URL Domain** — dạng `<MÃ_PROJECT>.supabase.co` (bắt buộc).
   - **Live Push URL** (webhook, không bắt buộc) — dạng `https://<MÃ_PROJECT>.supabase.co/functions/v1/kho-shopee`.
2. **Bước 2:** bấm **Kết nối shop Shopee** → đăng nhập tài khoản người bán → **Xác nhận cấp quyền** → tự quay về app.
3. **Bước 3:** tick **Lấy cả SỐ TỒN** → bấm **Lấy sản phẩm & tồn từ Shopee** → rồi **Kéo đơn hàng**.

Xong! Từ giờ máy chủ tự kéo đơn mỗi 20 phút và sao lưu kho mỗi đêm 23:40.

---

## Cách app tính kho (nên đọc 1 lần)
- **Hàng gốc** = món hàng thật trong kho, giữ **tồn thật** (màn *Kho hàng*). Mỗi phân loại Shopee mới đồng bộ về được tạo sẵn 1 hàng gốc 1:1.
- **Listing** = phân loại đang bán trên Shopee. Số tồn của listing là **số tính ra** = `min(tồn hàng gốc ÷ số lượng trong công thức)`.
- **Công thức combo**: vd listing "Combo 2 quần đen" = 2 × hàng gốc *Quần đen*. Bán listing nào cũng trừ vào hàng gốc → app tính lại và đẩy số mới lên **mọi** listing dùng chung.
- Đổi tồn luôn qua phiếu (nhập kho, kiểm kê, khách hoàn…) để báo cáo Xuất-Nhập-Tồn đúng.
- Sản phẩm mới: tạo trên Shopee trước → trong app bấm *Lấy sản phẩm từ Shopee* → app tự tạo listing + hàng gốc.

## Câu hỏi thường gặp
**"Tài khoản này không phải chủ shop" / "chưa biết ai là chủ shop"** — Project có hơn 1 tài khoản trước khi chủ shop đăng nhập lần đầu. Đặt chủ shop bằng tay ở SQL Editor:
```sql
update public.kho_settings set owner_email = 'email-cua-ban@vidu.com' where id = 1;
```

**Màn Kết nối báo "không gọi được máy chủ"** — Chưa deploy function `kho-shopee` (bước 3), sai tên function, hoặc chưa tắt Verify JWT.

**Shopee báo lỗi redirect khi cấp quyền** — Kiểm tra *Redirect URL Domain* trong app Shopee Open Platform đúng `<MÃ_PROJECT>.supabase.co`; đúng môi trường (Partner Key Test dùng với *Thử nghiệm*, Key Live dùng với *Shop thật*).

**Không muốn app đẩy tồn lên Shopee (chỉ xem báo cáo)** — chạy SQL:
```sql
update public.kho_settings set push_stock_enabled = false where id = 1;
```

**Lệch 1–2 cái giữa app và Shopee** — thường do đơn *chưa thanh toán* (Shopee giữ hàng ngay, app chỉ trừ khi đơn sang *Chờ lấy hàng*), hoặc có phần mềm khác / nhân viên sửa tồn thẳng trên Shopee.

**Mạng chặn thư viện** — App tải thư viện từ `unpkg.com` và `cdn.tailwindcss.com`. Nếu trắng trang/không đăng nhập được, đổi mạng hoặc tắt VPN.

## Cập nhật phiên bản mới
1. Lấy mã mới (Sync fork trên GitHub — Vercel tự deploy lại giao diện).
2. Chạy lại `supabase/install.sql` mới ở SQL Editor (giữ nguyên dữ liệu).
3. Deploy lại function `kho-shopee` bằng nội dung file mới.

## Bảo mật
- Partner Key và token Shopee chỉ lưu ở bảng `kho_auth` — **không** có quyền đọc từ trình duyệt, chỉ máy chủ đọc được.
- Mọi bảng bật Row Level Security: chỉ email chủ shop đọc/ghi được.
- Repo này **không chứa** khoá bí mật nào. Đừng commit `web/config.js` có chứa secret key (file này chỉ để Publishable key — vốn là khoá công khai).
- Nên bật *Leaked password protection* (Supabase › Authentication › Policies/Passwords).

## Đóng góp
Báo lỗi / góp ý qua **Issues**, sửa mã qua **Pull Request**. Giao diện là 1 file `web/index.html` (JavaScript thuần + Tailwind CDN), không cần build.

## Giấy phép
[MIT](LICENSE) — dùng miễn phí cho mọi mục đích, không bảo hành. Bạn tự chịu trách nhiệm khi dùng với shop thật: hãy chạy thử với môi trường *Thử nghiệm* trước và luôn sao lưu.
