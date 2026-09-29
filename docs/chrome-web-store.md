# Chrome Web Store 提交材料

## 隐私政策网址

商店的「隐私权政策网址」填这两个之一（同一份文件，后者是纯文本、渲染更稳）：

```
https://github.com/imba97/offer-hunter/blob/main/docs/privacy-policy.md
https://raw.githubusercontent.com/imba97/offer-hunter/main/docs/privacy-policy.md
```

内容见仓库内的 [privacy-policy.md](./privacy-policy.md)，其中第 12 节即为商店要求的数据使用（Limited Use）声明。

## 权限说明（一句话版）

> 与后台六个输入框一一对应，直接粘贴。

**需请求权限的理由**

```
本扩展只做一件事：在已支持的招聘网站（BOSS 直聘、电鸭社区）职位页上用你自己配置的 AI 比对简历与 JD 并生成打招呼语；所申请的 tabs / storage / activeTab / sidePanel 与这两个域名的主机权限都只服务于这一件事，没有申请任何多余权限。
```

**需请求 tabs 的理由**

```
用于判断当前标签页是不是已支持的招聘网站职位页（决定展开侧边栏还是打开职位页），并定位需要通信的那个标签页。
```

**需请求 storage 的理由**

```
仅用于读取 1.0.4 及更早版本遗留在 chrome.storage.local 中的数据，以完成一次性迁移；迁移校验无损后旧数据即被删除。日常读写使用扩展自己的 IndexedDB，不需要任何权限，也不上传。
```

**需请求 activeTab 的理由**

```
仅在你主动点击扩展图标时临时获取当前标签页的访问权，用于同一个判断：当前标签页是否为已支持的招聘网站职位页。
```

**需请求 sidePanel 的理由**

```
扩展的全部界面（岗位详情、匹配结果、打招呼语）都用浏览器原生侧边栏展示，不向页面注入任何 UI。
```

**需请求主机权限的理由**

```
只在 zhipin.com 与 eleduck.com 的职位页读取你正在查看的那个岗位信息，用于与你的简历做匹配分析；不读取 Cookie、不代发消息、不批量抓取，除你自己配置的 AI 接口外不向任何第三方发送数据。
```
