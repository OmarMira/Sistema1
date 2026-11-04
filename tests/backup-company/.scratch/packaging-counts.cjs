const fs=require('node:fs');const {execFileSync}=require('node:child_process');
const groups={
  slice1:['src/lib/db.ts','src/lib/backup.ts','src/lib/backup-format.ts','src/lib/backup-storage.ts','tests/backup-company/helpers.ts','tests/backup-company/export.test.ts','docs/company-backup-format.md'],
  slice2:['src/lib/backup-validation.ts','src/lib/backup-restore.ts','tests/backup-company/restore.test.ts','tests/backup-company/fidelity.test.ts','tests/backup-company/public-pg.integration.ts','vitest.company-backup-pg.config.mts','docs/company-backup-recovery.md'],
  inherited_parent_disposition:['docs/backup-maintenance.md'],
};
for(const [group,files] of Object.entries(groups)){
 let additions=0,deletions=0;
 for(const file of files){
  const diff=execFileSync('git',['diff','HEAD','--numstat','--',file],{encoding:'utf8'}).trim();
  let add=0,del=0;
  if(diff){[add,del]=diff.split('\t').slice(0,2).map(Number);}
  else{let tracked=true;try{execFileSync('git',['ls-files','--error-unmatch','--',file],{stdio:'ignore'});}catch{tracked=false;}
   if(!tracked){const text=fs.readFileSync(file,'utf8');add=text.split('\n').length-(text.endsWith('\n')?1:0);}}
  additions+=add;deletions+=del;console.log(group,`+${add}/-${del}`,file);
 }
 console.log('TOTAL',group,`+${additions}/-${deletions}`,`authored=${additions+deletions}`);
}
