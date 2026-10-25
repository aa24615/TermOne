export async function activate({ host, manifest }) {
  host.ui.render({type:"column",children:[
    {type:"text",text:manifest.name + "：这是独立应用窗口。"},
    {type:"button",text:"显示应用通知",onClick:()=>host.toast("通知只显示在本应用窗口")},
  ]});
}
